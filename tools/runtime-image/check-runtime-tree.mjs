#!/usr/bin/env node
// The root Dockerfile's `runtime-deps` stage runs this after `npm prune` (#263, #819). It has no dependencies
// because it must run in that stage with nothing but Node; the Dockerfile copies this one file in.
//
// The runtime image must hold exactly the packages the workspace lockfile pins for wrangler. Three things are
// compared — the workspace lockfile, the pruned lockfile, and node_modules on disk — in both directions, and the
// comparison has to cover a known minimum, so that reading the wrong directory cannot pass as "no drift".
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @typedef {{ version?: string, resolved?: string, integrity?: string, optional?: boolean, link?: boolean,
 *   os?: string[], cpu?: string[], devDependencies?: Record<string, string> }} LockEntry
 * @typedef {{ packages?: Record<string, LockEntry> }} Lockfile
 * @typedef {{ os: string, cpu: string }} Platform
 * @typedef {{ root: string, workspaceLock: Lockfile, runtimeLock: Lockfile, platform: Platform,
 *   minCompared?: number, sharpFloor?: string }} CheckInput
 * @typedef {{ compared: number, problems: string[] }} CheckResult
 */

/** The pruned tree has 43 packages on linux (2026-11). A floor, not the exact count: a wrangler bump may move it. */
export const MIN_COMPARED = 30;
/** The `miniflare.sharp` override exists for a fix that landed in 0.35.5; an older sharp means it was dropped. */
export const SHARP_FLOOR = '0.35.5';
const WRANGLER = 'node_modules/wrangler';

/**
 * npm's own rule for `os`/`cpu`: a list of allowed values, or of `!`-prefixed refused ones.
 * @param {string[] | undefined} list
 * @param {string} value
 */
function allows(list, value) {
  if (!list || list.length === 0) return true;
  if (list.includes(`!${value}`)) return false;
  const allowed = list.filter((item) => !item.startsWith('!'));
  return allowed.length === 0 || allowed.includes(value) || allowed.includes('any');
}

/**
 * @param {LockEntry} entry
 * @param {Platform} platform
 */
function targetsPlatform(entry, platform) {
  return allows(entry.os, platform.os) && allows(entry.cpu, platform.cpu);
}

/**
 * Release versions only: a pre-release or anything unparsable is null, which the caller treats as below the floor.
 * @param {string | undefined} version
 * @returns {[number, number, number] | null}
 */
function parseRelease(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '');
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * @param {string | undefined} version
 * @param {string} floor
 */
export function isAtLeast(version, floor) {
  const have = parseRelease(version);
  const want = parseRelease(floor);
  if (!have || !want) return false;
  for (const [index, part] of have.entries()) {
    const floorPart = want[index] ?? 0;
    if (part !== floorPart) return part > floorPart;
  }
  return true;
}

/**
 * Every package directory under `<root>/node_modules`, as lockfile keys (`node_modules/a/node_modules/@s/b`).
 * It follows npm's layout only — `node_modules/<name>` and `node_modules/@scope/<name>`, recursively — so a
 * `package.json` a package ships among its own files is not taken for an installed package. A symlink is
 * reported and never followed, a `node_modules` directory included. Whatever else sits where npm puts packages
 * is reported as `unexpected`: a plain file, and any dot entry but the two npm writes itself — `.bin`, which
 * may hold only links into its own `node_modules`, and the hidden lockfile at the top.
 * @param {string} root
 * @returns {{ packages: string[], links: string[], unexpected: string[] }}
 */
export function installedPackages(root) {
  /** @type {string[]} */
  const packages = [];
  /** @type {string[]} */
  const links = [];
  /** @type {string[]} */
  const unexpected = [];

  /**
   * Reports the entry unless it is a real directory.
   * @param {string} key
   * @param {string} otherwise what a non-directory is reported as
   */
  const isRealDirectory = (key, otherwise) => {
    const stat = lstatSync(join(root, key));
    if (stat.isSymbolicLink()) links.push(key);
    else if (!stat.isDirectory()) unexpected.push(`${key}: ${otherwise}`);
    else return true;
    return false;
  };

  /** @param {string} key a lockfile key of a candidate package directory */
  const visitPackage = (key) => {
    if (!isRealDirectory(key, 'a file where a package directory belongs')) return;
    packages.push(key);
    visitModules(`${key}/node_modules`);
  };

  /**
   * npm links a package's executables as `.bin/<name> -> ../<package>/<file>`; the package itself is then held
   * to the lockfile by the walk. Anything else in `.bin` would be code on PATH that no lockfile entry covers.
   * @param {string} bin a `…/node_modules/.bin` entry, relative to root
   */
  const visitBin = (bin) => {
    if (!isRealDirectory(bin, 'a file, not the directory npm links executables in')) return;
    const modules = join(root, dirname(bin));
    for (const name of readdirSync(join(root, bin)).sort()) {
      const key = `${bin}/${name}`;
      const path = join(root, key);
      if (!lstatSync(path).isSymbolicLink()) {
        unexpected.push(`${key}: not a link to a package executable`);
        continue;
      }
      const target = relative(modules, resolve(dirname(path), readlinkSync(path)));
      if (target === '' || target.startsWith('.') || isAbsolute(target)) {
        unexpected.push(`${key}: links outside the packages of its node_modules`);
      }
    }
  };

  /**
   * @param {string} key a dot entry, relative to root
   * @param {boolean} isTopLevel whether it sits in `<root>/node_modules` itself
   */
  const visitDotEntry = (key, isTopLevel) => {
    const stat = lstatSync(join(root, key));
    if (stat.isSymbolicLink()) links.push(key);
    // npm's hidden lockfile: only ever at the top, and only a regular file.
    else if (isTopLevel && key.endsWith('/.package-lock.json') && stat.isFile()) return;
    else unexpected.push(`${key}: a dot entry npm does not create`);
  };

  /** @param {string} modules a `…/node_modules` directory, relative to root */
  const visitModules = (modules) => {
    if (!lstatSync(join(root, modules), { throwIfNoEntry: false })) return;
    if (!isRealDirectory(modules, 'a file, not a directory')) return;
    for (const name of readdirSync(join(root, modules)).sort()) {
      const key = `${modules}/${name}`;
      if (name === '.bin') visitBin(key);
      else if (name.startsWith('.')) visitDotEntry(key, modules === 'node_modules');
      else if (!name.startsWith('@')) visitPackage(key);
      else if (isRealDirectory(key, 'a file where a scope directory belongs')) {
        for (const scoped of readdirSync(join(root, key)).sort()) {
          if (scoped.startsWith('.')) visitDotEntry(`${key}/${scoped}`, false);
          else visitPackage(`${key}/${scoped}`);
        }
      }
    }
  };

  visitModules('node_modules');
  return { packages, links, unexpected };
}

/**
 * @param {string} root
 * @param {string} key
 * @returns {string | undefined}
 */
function installedVersion(root, key) {
  const manifest = join(root, key, 'package.json');
  if (!existsSync(manifest)) return undefined;
  return /** @type {{ version?: string }} */ (JSON.parse(readFileSync(manifest, 'utf8'))).version;
}

/**
 * @param {CheckInput} input
 * @returns {CheckResult}
 */
export function checkRuntimeTree({
  root,
  workspaceLock,
  runtimeLock,
  platform,
  minCompared = MIN_COMPARED,
  sharpFloor = SHARP_FLOOR,
}) {
  /** @type {string[]} */
  const problems = [];
  const workspace = workspaceLock.packages ?? {};
  const runtime = runtimeLock.packages ?? {};
  let compared = 0;

  // Forward: everything the pruned lockfile lists is the workspace lockfile's own entry, and is on disk.
  for (const [key, entry] of Object.entries(runtime)) {
    if (key === '') continue;
    const locked = workspace[key];
    if (!locked) {
      problems.push(`${key}: in the pruned lockfile but not in the workspace lockfile`);
      continue;
    }
    for (const field of /** @type {const} */ (['version', 'resolved', 'integrity'])) {
      if (entry[field] !== locked[field]) {
        problems.push(
          `${key}: pruned lockfile ${field} ${entry[field]} != workspace lockfile ${locked[field]}`,
        );
      }
    }
    if (entry.link) {
      problems.push(`${key}: a link, the runtime tree has no workspaces`);
      continue;
    }
    const installed = installedVersion(root, key);
    if (installed === undefined) {
      // Only an optional build for another OS or CPU may be absent. An optional package that targets this
      // platform (workerd, esbuild and sharp ship their binaries that way) is required here.
      if (!entry.optional) problems.push(`${key}: missing`);
      else if (targetsPlatform(entry, platform)) {
        problems.push(`${key}: missing, though it targets ${platform.os}/${platform.cpu}`);
      }
      continue;
    }
    if (installed !== locked.version) {
      problems.push(`${key}: installed ${installed} != workspace lockfile ${locked.version}`);
    }
    compared += 1;
  }

  // Reverse: nothing is on disk that the pruned lockfile does not list.
  const onDisk = installedPackages(root);
  for (const key of onDisk.links) problems.push(`${key}: a symlink in node_modules`);
  problems.push(...onDisk.unexpected);
  for (const key of onDisk.packages) {
    if (!runtime[key]) problems.push(`${key}: on disk but not in the pruned lockfile`);
    else if (installedVersion(root, key) === undefined)
      problems.push(`${key}: on disk without a package.json`);
  }

  // Not vacuous: the comparison covered the tree this image is built for.
  if (compared < minCompared) {
    problems.push(`only ${compared} packages compared, expected at least ${minCompared}`);
  }
  const wantedWrangler = workspace['']?.devDependencies?.['wrangler'];
  const wrangler = runtime[WRANGLER] ? installedVersion(root, WRANGLER) : undefined;
  if (wantedWrangler === undefined) {
    problems.push('the workspace lockfile has no devDependencies.wrangler');
  } else if (wrangler === undefined) {
    problems.push(`${WRANGLER}: not in the runtime tree, expected ${wantedWrangler}`);
  } else if (wrangler !== wantedWrangler) {
    problems.push(`${WRANGLER}: installed ${wrangler} != package.json ${wantedWrangler}`);
  }
  const sharps = onDisk.packages.filter((key) => key.endsWith('node_modules/sharp'));
  if (sharps.length === 0) problems.push(`sharp: not installed, expected >= ${sharpFloor}`);
  for (const key of sharps) {
    const version = installedVersion(root, key);
    if (!isAtLeast(version, sharpFloor)) problems.push(`${key}: ${version} is below ${sharpFloor}`);
  }

  return { compared, problems };
}

/**
 * @param {string} path
 * @returns {Lockfile}
 */
function readLock(path) {
  return /** @type {Lockfile} */ (JSON.parse(readFileSync(path, 'utf8')));
}

/**
 * @param {string[]} argv `<workspace-lockfile> [root]`
 * @returns {0 | 1 | 2} 0 the tree matches, 1 it drifts, 2 the check could not be made
 */
function main(argv) {
  const [workspaceLockPath, rootArg] = argv;
  if (!workspaceLockPath) {
    console.error('usage: check-runtime-tree.mjs <workspace-lockfile> [root]');
    return 2;
  }
  const root = resolve(rootArg ?? '.');
  /** @type {CheckResult} */
  let result;
  try {
    result = checkRuntimeTree({
      root,
      workspaceLock: readLock(workspaceLockPath),
      runtimeLock: readLock(join(root, 'package-lock.json')),
      platform: { os: process.platform, cpu: process.arch },
    });
  } catch (error) {
    // An unreadable or unparsable lockfile or manifest is not drift: say so, with an exit code of its own.
    console.error(`cannot check the runtime tree: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const { compared, problems } = result;
  if (problems.length > 0) {
    console.error(`runtime tree drifts from package-lock.json:\n${problems.join('\n')}`);
    return 1;
  }
  console.log(`runtime tree matches package-lock.json: ${compared} packages compared`);
  return 0;
}

/**
 * Whether Node was started with this file. Both sides go through realpath: Node resolves a symlinked entry
 * before it sets `import.meta.url` (unless `--preserve-symlinks-main`), while `argv[1]` keeps the path as typed,
 * so comparing them as-is skipped `main()` and exited 0 without checking (#998). A path that cannot be resolved
 * throws, so that case fails the build too.
 */
function isEntryPoint() {
  const entry = process.argv[1];
  // No script path (`node -e`, a script piped to stdin): nothing says this file was meant to run, and guessing
  // "imported" would end 0 without doing the work.
  if (entry === undefined)
    throw new Error(`check-runtime-tree.mjs must be started as a file: node check-runtime-tree.mjs …`);
  return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
}

if (isEntryPoint()) process.exitCode = main(process.argv.slice(2));
