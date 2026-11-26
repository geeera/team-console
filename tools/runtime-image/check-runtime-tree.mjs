#!/usr/bin/env node
// The root Dockerfile's `runtime-deps` stage runs this after `npm prune` (#263, #819). It has no dependencies
// because it must run in that stage with nothing but Node; the Dockerfile copies this one file in.
//
// The runtime image must hold exactly the packages the workspace lockfile pins for wrangler. Three things are
// compared — the workspace lockfile, the pruned lockfile, and node_modules on disk — in both directions, and the
// comparison has to cover a known minimum, so that reading the wrong directory cannot pass as "no drift".
// Besides the packages: `.bin` holds only the executables its packages declare, each a regular file reached
// through no other link; nothing else in node_modules is a symlink, setuid, setgid or a special file; and the
// manifest the tree was pruned under still carries the overrides, in npm's shape and with the pins named below.
// And no optional package is on disk that only absent packages depend on (#1012); `--prune-unneeded` removes
// those, because `npm prune` keeps them: the Dockerfile runs that mode between `npm prune` and the check.
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @typedef {{ version?: string, resolved?: string, integrity?: string, optional?: boolean, link?: boolean,
 *   os?: string[], cpu?: string[], dependencies?: Record<string, string>,
 *   optionalDependencies?: Record<string, string>, peerDependencies?: Record<string, string>,
 *   devDependencies?: Record<string, string> }} LockEntry
 * @typedef {{ packages?: Record<string, LockEntry> }} Lockfile
 * @typedef {{ os: string, cpu: string }} Platform
 * @typedef {{ root: string, workspaceLock: Lockfile, runtimeLock: Lockfile, runtimeManifest: unknown,
 *   platform: Platform, minCompared?: number, sharpFloor?: string }} CheckInput
 * @typedef {{ compared: number, problems: string[] }} CheckResult
 */

/** The pruned tree has 40 packages on linux (#1012). A floor, not the exact count: a wrangler bump may move it. */
export const MIN_COMPARED = 30;
/** The `miniflare.sharp` override exists for a fix that landed in 0.35.5; an older sharp means it was dropped. */
export const SHARP_FLOOR = '0.35.5';
/**
 * What the workspace's `overrides` exist to pin in this tree (#263), each with the package that depends on it in
 * wrangler's tree. The Dockerfile lists the pinned names with `npm ls`; check-runtime-tree.spec.ts holds both
 * sides to that line and to the lockfile.
 * @type {Readonly<Record<string, string>>}
 */
export const PINNED_BY_OVERRIDE = { sharp: 'miniflare', undici: 'miniflare' };
const WRANGLER = 'node_modules/wrangler';
/** Where npm links executables: `.bin/<name>` of the top node_modules or of a package's own. */
const BIN_LINK = /^node_modules\/(?:(?:@[^/]+\/[^/.][^/]*|[^/.@][^/]*)\/node_modules\/)*\.bin\/[^/]+$/;

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
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
 * may hold only the links its own packages declare in their `bin` map, and the hidden lockfile at the top.
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
   * npm links a package's executables as `.bin/<name> -> ../<package>/<file>`, from the package's `bin` map; the
   * package itself is then held to the lockfile by the walk. Anything else in `.bin` would be code on PATH that
   * no lockfile entry covers, and a link the package does not declare would put another of its files there
   * under a name of the writer's choosing (#1005).
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
        continue;
      }
      const problem =
        undeclaredExecutable(modules, name, target.split(sep).join('/')) ??
        unreachableFile(path, modules, target);
      if (problem) unexpected.push(`${key}: ${problem}`);
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
 * What is wrong with `.bin/<name> -> <target>`, or undefined when the package the target sits in declares
 * exactly that file under that name. The comparison is of paths as written; nothing behind the link is read
 * but the package's own package.json.
 * @param {string} modules the absolute `node_modules` directory the `.bin` is in
 * @param {string} name the link's name
 * @param {string} target the link's target relative to `modules`, with `/` separators
 * @returns {string | undefined}
 */
function undeclaredExecutable(modules, name, target) {
  const segments = target.split('/');
  const packageName = segments.slice(0, target.startsWith('@') ? 2 : 1).join('/');
  const manifestPath = join(modules, packageName, 'package.json');
  // A symlinked package directory is reported by the walk; its manifest is not read through the link.
  const isReadable =
    lstatSync(join(modules, packageName), { throwIfNoEntry: false })?.isDirectory() === true &&
    lstatSync(manifestPath, { throwIfNoEntry: false })?.isFile() === true;
  if (!isReadable) return `links into ${packageName}, which has no package.json`;
  // Drift either way, not a check that could not be made: the link is on disk and nothing readable declares it.
  /** @type {string} */
  let text;
  try {
    text = readFileSync(manifestPath, 'utf8');
  } catch (error) {
    const code = isRecord(error) && typeof error['code'] === 'string' ? error['code'] : 'a read error';
    return `links into ${packageName}, whose package.json cannot be read (${code})`;
  }
  /** @type {unknown} */
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    return `links into ${packageName}, whose package.json is not JSON`;
  }
  const bin = isRecord(manifest) ? manifest['bin'] : undefined;
  /** @type {unknown} */
  let declared;
  // npm's two forms: one file under the package's own (unscoped) name, or a map of names to files.
  if (typeof bin === 'string') declared = name === packageName.split('/').at(-1) ? bin : undefined;
  else if (typeof bin === 'object' && bin !== null && Object.hasOwn(bin, name)) {
    declared = /** @type {Record<string, unknown>} */ (bin)[name];
  }
  if (typeof declared !== 'string' || declared === '') {
    return `${packageName} declares no "${name}" executable`;
  }
  const wanted = posix.join(packageName, declared);
  return wanted === target ? undefined : `links to ${target}, but ${packageName} declares ${wanted}`;
}

/**
 * What is wrong with the file a `.bin` link names, or undefined when it is a regular file at that very path.
 * The declared path is compared as written, but the kernel resolves it: through a linked directory
 * (`pkg/sub -> /usr/bin` with `../pkg/sub/../cli.js`) or a declared file that is itself a link to `/bin/sh`,
 * the name on PATH would run something no lockfile entry covers (#1013).
 * @param {string} link the absolute path of the `.bin` link
 * @param {string} modules the absolute `node_modules` directory the `.bin` is in
 * @param {string} target the link's target relative to `modules`, `..` and `.` already folded away
 * @returns {string | undefined}
 */
function unreachableFile(link, modules, target) {
  /** @type {string} */
  let real;
  try {
    // The kernel's answer for the link as written. Folding `sub/..` first is what hides a linked `sub`, and
    // Node's own `realpathSync` folds a link's target that way before it looks; libc's realpath does not.
    real = realpathSync.native(link);
  } catch {
    return `links to ${target.split(sep).join('/')}, which does not exist`;
  }
  if (real !== join(realpathSync.native(modules), target)) return 'reaches its file through another symlink';
  return lstatSync(real).isFile() ? undefined : 'links to something that is not a regular file';
}

/**
 * Every path under `<root>/node_modules` that no npm package installs and a container must not get by copy
 * (#1005): a setuid or setgid bit, on a file or a directory, anything that is not a file, a directory or a
 * symlink (a device, a fifo, a socket), and every symlink but the `.bin` links, which the walk above holds to
 * their packages (#1013: the tree npm installs for wrangler has no other). Symlinks are not followed.
 * @param {string} root
 * @returns {string[]} one problem per path, the path relative to root
 */
export function specialFiles(root) {
  /** @type {string[]} */
  const problems = [];
  /** @param {string} key */
  const visit = (key) => {
    const stat = lstatSync(join(root, key), { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      if (!BIN_LINK.test(key)) problems.push(`${key}: a symlink in node_modules`);
      return;
    }
    if (!stat.isFile() && !stat.isDirectory()) {
      problems.push(`${key}: a device, fifo or socket, not a file`);
      return;
    }
    if ((stat.mode & 0o6000) !== 0) {
      problems.push(`${key}: setuid or setgid (mode ${(stat.mode & 0o7777).toString(8)})`);
    }
    if (stat.isDirectory()) for (const name of readdirSync(join(root, key)).sort()) visit(`${key}/${name}`);
  };
  visit('node_modules');
  return problems;
}

/**
 * What is wrong with the `overrides` of the manifest the tree was pruned under. npm's shape: a map of package
 * names to a version, or to a map of the same for that package's own dependencies (`.` being the package
 * itself). A non-empty map of anything else passed before (#1013), though npm would not read it as these pins.
 * A pin counts only where npm applies it to the copy the Dockerfile's `npm ls` names (#1019): at the top, for
 * every copy, or directly under the package that depends on it. Deeper, or under another package, it pins a
 * copy this tree may not have.
 * @param {unknown} manifest the parsed runtime package.json
 * @param {Readonly<Record<string, string>>} [pinned] packages some override must pin, each to the package
 *   that depends on it
 * @returns {string[]}
 */
export function overrideProblems(manifest, pinned = PINNED_BY_OVERRIDE) {
  const overrides = isRecord(manifest) ? manifest['overrides'] : undefined;
  if (!isRecord(overrides) || Object.keys(overrides).length === 0) {
    return ['package.json: the runtime manifest has no overrides'];
  }
  /** @type {string[]} */
  const problems = [];
  /** @type {{ name: string, under: string[], path: string }[]} */
  const pins = [];
  /**
   * @param {Record<string, unknown>} map
   * @param {string} at
   * @param {string[]} owners the packages this map is nested under, outermost first; the last owns the map
   */
  const visit = (map, at, owners) => {
    for (const [key, value] of Object.entries(map)) {
      const path = `${at}.${JSON.stringify(key)}`;
      // A key may carry a range (`sharp@^0.34`), and `.` is the package the map belongs to.
      const name = key === '.' ? owners.at(-1) : key.replace(/(?!^)@.*$/, '');
      const under = key === '.' ? owners.slice(0, -1) : owners;
      if (name === undefined || name === '') problems.push(`package.json: ${path} names no package`);
      else if (typeof value === 'string' && value !== '') pins.push({ name, under, path });
      else if (isRecord(value) && Object.keys(value).length > 0) visit(value, path, [...owners, name]);
      else problems.push(`package.json: ${path} is neither a version nor a map of overrides`);
    }
  };
  visit(overrides, 'overrides', []);
  for (const [name, dependent] of Object.entries(pinned)) {
    const named = pins.filter((pin) => pin.name === name);
    const applies = (/** @type {{ under: string[] }} */ pin) =>
      pin.under.length === 0 || (pin.under.length === 1 && pin.under[0] === dependent);
    if (named.length === 0) problems.push(`package.json: no override pins ${name}`);
    else if (!named.some(applies)) {
      for (const pin of named) {
        problems.push(
          `package.json: ${pin.path} does not pin ${dependent}'s ${name}; only a pin at the top or under ${dependent} does`,
        );
      }
    }
  }
  return problems;
}

/**
 * The lockfile key `name` resolves to from the package at `from`, the way Node finds it: the package's own
 * node_modules first, then each enclosing one up to the top. Undefined when the lockfile has no such package.
 * @param {Record<string, LockEntry>} packages
 * @param {string} from a lockfile key, `''` for the root
 * @param {string} name
 * @returns {string | undefined}
 */
function resolveDependency(packages, from, name) {
  let base = from;
  for (;;) {
    const key = base === '' ? `node_modules/${name}` : `${base}/node_modules/${name}`;
    if (packages[key]) return key;
    if (base === '') return undefined;
    const enclosing = base.lastIndexOf('/node_modules/');
    base = enclosing === -1 ? '' : base.slice(0, enclosing);
  }
}

/**
 * Which optional packages the tree needs (#1012). npm installs a skipped platform build's own dependencies when
 * they name no platform: sharp 0.35.5's optional `@img/sharp-freebsd-wasm32` and `@img/sharp-webcontainers-wasm32`
 * are skipped on linux, yet `@img/sharp-wasm32` they both depend on, its `@emnapi/runtime` and that one's `tslib`
 * were installed, and `npm prune` keeps them. An optional package is needed only while a package on disk that
 * is needed depends on it, through any kind of dependency npm draws an edge for. The root and every
 * non-optional package on disk are needed as such: the lockfile does not let npm skip them.
 * @param {Record<string, LockEntry>} packages the pruned lockfile's packages
 * @param {ReadonlySet<string>} present the lockfile keys installed on disk
 * @returns {{ needed: Set<string>, wanted: Set<string> }} the needed packages on disk, and every key some needed
 *   package depends on, installed or not
 */
export function neededPackages(packages, present) {
  /** @type {Set<string>} */
  const wanted = new Set();
  const needed = new Set(
    [...present].filter((key) => packages[key] !== undefined && packages[key].optional !== true),
  );
  const queue = ['', ...needed];
  for (let key = queue.pop(); key !== undefined; key = queue.pop()) {
    const entry = packages[key];
    if (!entry) continue;
    const names = new Set([
      ...Object.keys(entry.dependencies ?? {}),
      ...Object.keys(entry.optionalDependencies ?? {}),
      ...Object.keys(entry.peerDependencies ?? {}),
    ]);
    for (const name of names) {
      const target = resolveDependency(packages, key, name);
      if (target === undefined) continue;
      wanted.add(target);
      if (present.has(target) && !needed.has(target)) {
        needed.add(target);
        queue.push(target);
      }
    }
  }
  return { needed, wanted };
}

/**
 * The optional packages on disk that no needed package depends on, outermost first; a nested one is listed
 * though removing its parent takes it along.
 * @param {Record<string, LockEntry>} packages the pruned lockfile's packages
 * @param {ReadonlySet<string>} present the lockfile keys installed on disk
 * @returns {string[]}
 */
export function unneededOptionals(packages, present) {
  const { needed } = neededPackages(packages, present);
  return [...present].filter((key) => packages[key]?.optional === true && !needed.has(key)).sort();
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
  runtimeManifest,
  platform,
  minCompared = MIN_COMPARED,
  sharpFloor = SHARP_FLOOR,
}) {
  /** @type {string[]} */
  const problems = [];
  const workspace = workspaceLock.packages ?? {};
  const runtime = runtimeLock.packages ?? {};
  let compared = 0;
  const onDisk = installedPackages(root);
  const present = presentPackages(root, runtime, onDisk.packages);
  const { wanted } = neededPackages(runtime, present);

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
      // Only an optional build for another OS or CPU may be absent, or an optional package nothing the tree needs
      // depends on (#1012). An optional package that targets this platform and that a needed package depends on
      // (workerd, esbuild and sharp ship their binaries that way) is required here.
      if (!entry.optional) problems.push(`${key}: missing`);
      else if (targetsPlatform(entry, platform) && wanted.has(key)) {
        problems.push(`${key}: missing, though it targets ${platform.os}/${platform.cpu}`);
      }
      continue;
    }
    if (installed !== locked.version) {
      problems.push(`${key}: installed ${installed} != workspace lockfile ${locked.version}`);
    }
    compared += 1;
  }

  // Reverse: nothing is on disk that the pruned lockfile does not list, or that the tree does not need.
  for (const key of unneededOptionals(runtime, present)) {
    problems.push(`${key}: on disk, though no package the tree needs depends on it`);
  }
  for (const key of onDisk.links) problems.push(`${key}: a symlink in node_modules`);
  problems.push(...onDisk.unexpected);
  for (const key of onDisk.packages) {
    if (!runtime[key]) problems.push(`${key}: on disk but not in the pruned lockfile`);
    else if (installedVersion(root, key) === undefined)
      problems.push(`${key}: on disk without a package.json`);
  }
  // A symlink where npm puts packages is in both walks; it is one problem.
  for (const problem of specialFiles(root)) if (!problems.includes(problem)) problems.push(problem);

  // The tree was pruned under this manifest. Without the workspace's `overrides` npm is free to re-resolve the
  // packages they pin (sharp, undici) the next time it touches the tree (#263, #1005).
  problems.push(...overrideProblems(runtimeManifest));

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
 * The present lockfile keys under `<root>/node_modules`: real package directories with a package.json that the
 * pruned lockfile lists.
 * @param {string} root
 * @param {Record<string, LockEntry>} packages
 * @param {string[]} onDisk what installedPackages found
 */
function presentPackages(root, packages, onDisk) {
  return new Set(onDisk.filter((key) => packages[key] && installedVersion(root, key) !== undefined));
}

/**
 * The executable names a package's manifest declares, in npm's two `bin` forms.
 * @param {string} root
 * @param {string} key
 * @returns {string[]}
 */
function declaredExecutables(root, key) {
  const manifest = /** @type {unknown} */ (JSON.parse(readFileSync(join(root, key, 'package.json'), 'utf8')));
  const bin = isRecord(manifest) ? manifest['bin'] : undefined;
  if (typeof bin === 'string') return [key.split('/').at(-1) ?? ''];
  return isRecord(bin) ? Object.keys(bin) : [];
}

/**
 * Removes the optional packages no needed package depends on (#1012), with the `.bin` links npm made for them,
 * and a scope directory that is left empty. Only real package directories the walk found are removed, and
 * nothing is followed through a symlink.
 * @param {string} root
 * @param {Lockfile} runtimeLock the pruned lockfile, which keeps its entries: it is the record of what npm
 *   resolved, and the check accepts these packages being absent
 * @returns {string[]} the lockfile keys removed, a nested one only through its parent
 */
export function pruneUnneededOptionals(root, runtimeLock) {
  const packages = runtimeLock.packages ?? {};
  const present = presentPackages(root, packages, installedPackages(root).packages);
  /** @type {string[]} */
  const removed = [];
  for (const key of unneededOptionals(packages, present)) {
    if (removed.some((parent) => key.startsWith(`${parent}/`))) continue;
    const directory = join(root, key);
    const modules = key.slice(0, key.lastIndexOf('node_modules/') + 'node_modules'.length);
    for (const name of declaredExecutables(root, key)) {
      const link = join(root, modules, '.bin', name);
      if (!lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) continue;
      if (resolve(dirname(link), readlinkSync(link)).startsWith(`${directory}${sep}`)) unlinkSync(link);
    }
    rmSync(directory, { recursive: true });
    removed.push(key);
    const scope = dirname(directory);
    if (posix.basename(dirname(key)).startsWith('@') && readdirSync(scope).length === 0) rmdirSync(scope);
  }
  return removed;
}

/**
 * @param {string} path
 * @returns {Lockfile}
 */
function readLock(path) {
  return /** @type {Lockfile} */ (JSON.parse(readFileSync(path, 'utf8')));
}

/**
 * @param {string[]} argv `[root]`
 * @returns {0 | 2} 2 when the lockfile cannot be read or a package cannot be removed
 */
function pruneMain(argv) {
  const root = resolve(argv[0] ?? '.');
  /** @type {string[]} */
  let removed;
  try {
    removed = pruneUnneededOptionals(root, readLock(join(root, 'package-lock.json')));
  } catch (error) {
    console.error(`cannot prune the runtime tree: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  console.log(
    removed.length === 0
      ? 'no unneeded optional packages on disk'
      : `removed unneeded optional packages:\n${removed.join('\n')}`,
  );
  return 0;
}

/**
 * @param {string[]} argv `<workspace-lockfile> [root]`, or `--prune-unneeded [root]`
 * @returns {0 | 1 | 2} 0 the tree matches (or was pruned), 1 it drifts, 2 the check could not be made
 */
function main(argv) {
  if (argv[0] === '--prune-unneeded') return pruneMain(argv.slice(1));
  const [workspaceLockPath, rootArg] = argv;
  if (!workspaceLockPath) {
    console.error('usage: check-runtime-tree.mjs <workspace-lockfile> [root] | --prune-unneeded [root]');
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
      runtimeManifest: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')),
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
 * Whether Node was started with the module at `moduleUrl`. Both sides go through realpath: Node resolves a
 * symlinked entry before it sets `import.meta.url` (unless `--preserve-symlinks-main`), while `argv[1]` keeps the
 * path as typed, so comparing them as-is skipped `main()` and exited 0 without checking (#998). A path that
 * cannot be resolved throws, so that case fails the build too. Exported for guard-output.mjs, which runs from
 * the checkout; this file and the two the image build copies alone (runtime-package.mjs, image-files.mjs)
 * cannot import a sibling, so they keep their own copy.
 * @param {string} moduleUrl the caller's `import.meta.url`
 * @param {string} name the script's file name, for the message
 */
export function isEntryPoint(moduleUrl, name) {
  const entry = process.argv[1];
  // No script path (`node -e`, a script piped to stdin): nothing says this file was meant to run, and guessing
  // "imported" would end 0 without doing the work.
  if (entry === undefined) throw new Error(`${name} must be started as a file: node ${name} …`);
  return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
}

if (isEntryPoint(import.meta.url, 'check-runtime-tree.mjs')) process.exitCode = main(process.argv.slice(2));
