#!/usr/bin/env node
// CI's `runtime-image` job (#998, #818.3) holds the built root image to its file list: every path in the
// final image is either the pinned Node base image's own, or something the Dockerfile's `runtime` stage copies
// from the `runtime-deps` or `build` stage — same type, mode, size, content and link target, owned by `node`.
// Nothing else may be there, and nothing may be missing. What is copied may be a file, a directory or a symlink
// only, with no setuid or setgid bit, in the stage it comes from as much as in the image.
//
//   node image-files.mjs base-image <Dockerfile>   the pinned base image, for `docker pull`
//   node image-files.mjs list <stage>              one JSON line per path; runs inside a container of that stage
//   node image-files.mjs check <directory>         compares base.jsonl, runtime-deps.jsonl, build.jsonl and
//                                                  runtime.jsonl of that directory
//
// Exit codes: 0 as expected, 1 the image differs, 2 the check could not be made.
// No dependencies: `list` runs in the image's stages, which have nothing but Node (and, in two of them, a
// node_modules this file must not lean on).
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @typedef {'base' | 'runtime-deps' | 'build' | 'runtime'} Stage
 * @typedef {{ path: string, type: 'file' | 'directory' | 'link' | 'other', mode: string, uid: number,
 *   gid: number, size?: number, sha256?: string, link?: string }} FileEntry
 * @typedef {{ stage: 'runtime-deps' | 'build', path: string }} Copy
 * @typedef {Record<Stage, FileEntry[]>} Listings
 * @typedef {{ entries: number, fromBase: number, appFiles: string[], problems: string[] }} CheckResult
 */

export const APP = '/app';
/** `node` in the official image. */
export const OWNER = { uid: 1000, gid: 1000 };

/**
 * What the Dockerfile's `runtime` stage copies, source and destination being the same path in every line.
 * tools/runtime-image/image-files.spec.ts holds this table to the Dockerfile, so changing one without the
 * other fails before an image is built.
 * @type {readonly Copy[]}
 */
export const RUNTIME_COPIES = [
  { stage: 'runtime-deps', path: '/app/package.json' },
  { stage: 'runtime-deps', path: '/app/node_modules' },
  { stage: 'build', path: '/app/dist/apps/console/browser' },
  { stage: 'build', path: '/app/dist/apps/api' },
  { stage: 'build', path: '/app/apps/api/wrangler.jsonc' },
  { stage: 'build', path: '/app/apps/api/migrations' },
];

/**
 * The lockfiles npm writes for the runtime tree. They are the `runtime-deps` stage's working files (#998, #1005):
 * the image starts wrangler without npm, so neither may reach it, not even inside a copied directory.
 */
export const LOCKFILES = [
  '/app/package-lock.json',
  '/app/npm-shrinkwrap.json',
  '/app/node_modules/.package-lock.json',
];

/**
 * Whether the path is a lockfile by its file name, wherever it sits. The pattern is held to the name:
 * unanchored, `lock` also matched `/app/dist/blocklist` (#1005).
 * @param {string} path
 */
export function isLockfile(path) {
  return /(^|\/)(package-lock|npm-shrinkwrap|\.package-lock)\.json$/.test(path);
}

/** Kernel and device trees: listed as a directory, never entered. */
const NOT_ENTERED = new Set(['/proc', '/sys', '/dev']);
/** Docker writes these per container; they are not the image's. */
const PER_CONTAINER = new Set(['/etc/hosts', '/etc/hostname', '/etc/resolv.conf', '/.dockerenv']);
const STAGES = /** @type {const} */ (['base', 'runtime-deps', 'build', 'runtime']);
/** How many problems are printed in full; the count is always exact. */
const MAX_PRINTED = 60;

/**
 * @param {string} value
 * @returns {value is Stage}
 */
function isStage(value) {
  return /** @type {readonly string[]} */ (STAGES).includes(value);
}

/**
 * The image every stage starts from: the default of the Dockerfile's `ARG NODE_IMAGE`, which must be pinned by
 * digest.
 * @param {string} dockerfile the Dockerfile's text
 */
export function baseImageOf(dockerfile) {
  const defaults = [...dockerfile.matchAll(/^ARG NODE_IMAGE=(.*)$/gm)].map((match) => match[1]);
  if (defaults.length !== 1) throw new Error(`expected one ARG NODE_IMAGE=…, found ${defaults.length}`);
  const image = defaults[0] ?? '';
  if (!/^node:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/.test(image)) {
    throw new Error('ARG NODE_IMAGE is not a node:<tag>@sha256:<digest> reference');
  }
  return image;
}

/**
 * The paths `list` walks in a stage: all of the base and the final image, and only what is copied out of the
 * two intermediate stages (their `/app` holds the whole workspace and its node_modules).
 * @param {Stage} stage
 * @param {readonly Copy[]} [copies]
 */
export function rootsOf(stage, copies = RUNTIME_COPIES) {
  if (stage === 'base' || stage === 'runtime') return ['/'];
  return copies.filter((copy) => copy.stage === stage).map((copy) => copy.path);
}

/**
 * @param {string} path
 * @returns {FileEntry}
 */
function entryOf(path) {
  const stat = lstatSync(path);
  /** @type {FileEntry} */
  const entry = {
    path,
    type: stat.isFile()
      ? 'file'
      : stat.isDirectory()
        ? 'directory'
        : stat.isSymbolicLink()
          ? 'link'
          : 'other',
    mode: (stat.mode & 0o7777).toString(8),
    uid: stat.uid,
    gid: stat.gid,
  };
  if (entry.type === 'file') {
    entry.size = stat.size;
    entry.sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
  }
  if (entry.type === 'link') entry.link = readlinkSync(path);
  return entry;
}

/**
 * Every path at and under the roots, sorted. A symlink is recorded and never followed; a directory's size is
 * left out (a filesystem artefact).
 * @param {readonly string[]} roots absolute paths
 * @param {{ skip?: ReadonlySet<string>, notEntered?: ReadonlySet<string> }} [options]
 * @returns {FileEntry[]}
 */
export function listFiles(roots, { skip = PER_CONTAINER, notEntered = NOT_ENTERED } = {}) {
  /** @type {FileEntry[]} */
  const entries = [];
  /** @param {string} path */
  const visit = (path) => {
    if (skip.has(path)) return;
    const entry = entryOf(path);
    entries.push(entry);
    if (entry.type !== 'directory' || notEntered.has(path)) return;
    for (const name of readdirSync(path).sort()) visit(join(path, name));
  };
  for (const root of roots) visit(root);
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * @param {string} path
 * @param {string} root
 */
const isAtOrUnder = (path, root) => path === root || path.startsWith(`${root}/`);

/**
 * The file list the final image must have, from the base image and the two stages it copies from.
 * @param {Pick<Listings, 'base' | 'runtime-deps' | 'build'>} listings
 * @param {readonly Copy[]} [copies]
 * @returns {{ expected: Map<string, FileEntry>, problems: string[] }}
 */
export function expectedFiles(listings, copies = RUNTIME_COPIES) {
  /** @type {Map<string, FileEntry>} */
  const expected = new Map();
  /** @type {string[]} */
  const problems = [];

  for (const entry of listings.base) {
    if (isAtOrUnder(entry.path, APP)) problems.push(`${entry.path}: already in the base image`);
    expected.set(entry.path, entry);
  }
  // `WORKDIR /app` and `RUN chown node:node /app`.
  expected.set(APP, { path: APP, type: 'directory', mode: '755', ...OWNER });

  for (const copy of copies) {
    if (!isAtOrUnder(copy.path, APP) || copy.path === APP) {
      problems.push(`${copy.path}: a copy outside ${APP}`);
      continue;
    }
    // As a line of the table, by its name alone. Inside a copied directory only LOCKFILES are refused, since a
    // package may ship a file of that name among its own.
    if (isLockfile(copy.path)) problems.push(`${copy.path}: a lockfile in the table of copies`);
    const copied = listings[copy.stage].filter((entry) => isAtOrUnder(entry.path, copy.path));
    if (!copied.some((entry) => entry.path === copy.path)) {
      problems.push(`${copy.path}: not in the ${copy.stage} stage`);
      continue;
    }
    // `COPY --chown=node:node`: the directories it has to create on the way belong to node as well.
    for (let parent = dirname(copy.path); parent !== APP; parent = dirname(parent)) {
      if (!expected.has(parent))
        expected.set(parent, { path: parent, type: 'directory', mode: '755', ...OWNER });
    }
    for (const entry of copied) {
      // Equal in the stage and in the image is not enough for these: the copy itself is the problem (#1005).
      if (entry.type === 'other') {
        problems.push(`${entry.path}: a device, fifo or socket in the ${copy.stage} stage`);
      } else if ((Number.parseInt(entry.mode, 8) & 0o6000) !== 0) {
        problems.push(`${entry.path}: setuid or setgid (mode ${entry.mode}) in the ${copy.stage} stage`);
      }
      expected.set(entry.path, { ...entry, ...OWNER });
    }
  }
  return { expected, problems };
}

/**
 * @param {FileEntry} expected
 * @param {FileEntry} actual
 * @returns {string[]} the fields that differ, as `field expected != actual`
 */
function differences(expected, actual) {
  /** @type {string[]} */
  const differing = [];
  for (const field of /** @type {const} */ (['type', 'mode', 'uid', 'gid', 'size', 'sha256', 'link'])) {
    if (expected[field] !== actual[field]) {
      differing.push(`${field} ${expected[field]} expected, ${actual[field]} in the image`);
    }
  }
  return differing;
}

/**
 * @param {Listings} listings
 * @param {readonly Copy[]} [copies]
 * @returns {CheckResult}
 */
export function checkImageFiles(listings, copies = RUNTIME_COPIES) {
  const { expected, problems } = expectedFiles(listings, copies);
  const actual = new Map(listings.runtime.map((entry) => [entry.path, entry]));

  for (const [path, entry] of expected) {
    const found = actual.get(path);
    if (!found) problems.push(`${path}: missing from the image`);
    else for (const difference of differences(entry, found)) problems.push(`${path}: ${difference}`);
  }
  for (const path of actual.keys()) {
    if (!expected.has(path)) problems.push(`${path}: in the image, but neither the base image's nor copied`);
  }
  for (const path of LOCKFILES) {
    if (actual.has(path)) problems.push(`${path}: a lockfile of the runtime-deps stage, not of the image`);
  }
  // A comparison of nothing with nothing must not pass.
  if (listings.base.length === 0) problems.push('the base image listing is empty');
  if (!actual.has(APP)) problems.push(`${APP}: the image listing has no ${APP}`);

  // The part of /app a reader can check by eye: everything but the two big copied trees.
  const bulky = ['/app/node_modules', '/app/dist'];
  const appFiles = listings.runtime
    .filter((entry) => entry.type !== 'directory' && isAtOrUnder(entry.path, APP))
    .filter((entry) => !bulky.some((root) => isAtOrUnder(entry.path, root)))
    .map((entry) => entry.path);

  return { entries: actual.size, fromBase: listings.base.length, appFiles, problems: problems.sort() };
}

/**
 * @param {string} path a file of JSON lines, as `list` prints
 * @returns {FileEntry[]}
 */
function readListing(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => /** @type {FileEntry} */ (JSON.parse(line)));
}

const USAGE = `usage: image-files.mjs base-image <Dockerfile>
       image-files.mjs list <${STAGES.join('|')}>
       image-files.mjs check <directory with ${STAGES.map((stage) => `${stage}.jsonl`).join(', ')}>`;

/**
 * @param {string[]} argv
 * @returns {0 | 1 | 2}
 */
function main(argv) {
  const [command, argument, ...rest] = argv;
  if (!command || !argument || rest.length > 0 || !['base-image', 'list', 'check'].includes(command)) {
    console.error(USAGE);
    return 2;
  }
  try {
    if (command === 'base-image') {
      console.log(baseImageOf(readFileSync(argument, 'utf8')));
      return 0;
    }
    if (command === 'list') {
      if (!isStage(argument)) throw new Error(`unknown stage ${JSON.stringify(argument)}`);
      // This file is mounted into the container it lists; it is not the image's.
      const skip = new Set([...PER_CONTAINER, realpathSync(fileURLToPath(import.meta.url))]);
      for (const entry of listFiles(rootsOf(argument), { skip })) console.log(JSON.stringify(entry));
      return 0;
    }
    const listings = /** @type {Listings} */ (
      Object.fromEntries(STAGES.map((stage) => [stage, readListing(join(argument, `${stage}.jsonl`))]))
    );
    const { entries, fromBase, appFiles, problems } = checkImageFiles(listings);
    console.log(`under ${APP}, outside node_modules and dist:\n${appFiles.join('\n')}`);
    if (problems.length > 0) {
      const more = problems.length > MAX_PRINTED ? `\n… and ${problems.length - MAX_PRINTED} more` : '';
      console.error(
        `the runtime image is not the expected file list (${problems.length} problems):\n${problems.slice(0, MAX_PRINTED).join('\n')}${more}`,
      );
      return 1;
    }
    console.log(
      `the runtime image is the expected file list: ${entries} paths, ${fromBase} of them the base image's, the rest copied by the runtime stage`,
    );
    return 0;
  } catch (error) {
    console.error(`cannot check the image files: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

/** As in check-runtime-tree.mjs: realpath on both sides, so a symlinked entry still runs `main()`. */
function isEntryPoint() {
  const entry = process.argv[1];
  // No script path (`node -e`, a script piped to stdin): nothing says this file was meant to run, and guessing
  // "imported" would end 0 without doing the work.
  if (entry === undefined)
    throw new Error(`image-files.mjs must be started as a file: node image-files.mjs …`);
  return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
}

if (isEntryPoint()) process.exitCode = main(process.argv.slice(2));
