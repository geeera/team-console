import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
} from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  BUNDLE_FILE,
  NODE_FILE,
  RELEASE_FILES,
  RELEASE_SUMS_FILE,
  attestationVerifyArgs,
  compareRunnerVersions,
  isRunnerVersionBelow,
  releaseDownloadArgs,
  releasePlatformOf,
  runnerReleaseChannelOf,
  tarballNameOf,
  type RunnerReleaseDto,
} from '@shared/contracts';
import type { UpdatePolicy } from '../config/config';
import { ensurePrivateDir, lstatOrNull } from '../config/private-files';
import type { Exec, ExecOptions } from '../host/exec';
import {
  BIN_DIR,
  BIN_FILES,
  BUNDLE_LINK,
  CURRENT_LINK,
  NODE_LINK,
  RELEASES_DIR,
  SUMS_LINK,
  binLinkTargetOf,
  releaseDirOf,
} from './install-layout';

/**
 * `team-console-runner update` (ADR 0008 decision 10, threat model C11 rows 1–2, RR13). The console only names a
 * version; whether a tarball may replace this binary is decided here, against the identity pinned in
 * `release-identity.ts`, by `gh attestation verify` (a dependency-free Sigstore verifier is out of reach for Stage A).
 * Every refusal is an `UpdateError` before anything in the install directory changes.
 */

export type UpdateProblem =
  | 'policy-off'
  | 'gh-missing'
  | 'platform-unsupported'
  | 'version-unreadable'
  | 'downgrade'
  | 'channel-mismatch'
  | 'below-minimum'
  | 'prefix-not-writable'
  | 'download-failed'
  | 'verification-failed'
  | 'unpack-failed';

export class UpdateError extends Error {
  constructor(
    readonly problem: UpdateProblem,
    message: string,
  ) {
    super(message);
    this.name = 'UpdateError';
  }
}

export type UpdateCheck =
  | { readonly kind: 'no-release'; readonly current: string }
  | { readonly kind: 'current'; readonly current: string; readonly target: string }
  | { readonly kind: 'available'; readonly current: string; readonly target: string };

export interface CheckDeps {
  readonly currentVersion: string;
  readonly policy: UpdatePolicy;
  readonly release: () => Promise<RunnerReleaseDto>;
}

/** What the console names, judged against this binary: no downgrade, nothing below the minimum, never with `off`. */
export async function checkForUpdate(deps: CheckDeps): Promise<UpdateCheck> {
  if (deps.policy === 'off') {
    throw new UpdateError(
      'policy-off',
      'updates are off for this runner (config.json update.policy = off); set it to notify or auto to update',
    );
  }
  const { version: target, minimumVersion } = await deps.release();
  const current = deps.currentVersion;
  if (target === null) {
    return { kind: 'no-release', current };
  }
  const order = compareRunnerVersions(target, current);
  if (order === null) {
    throw new UpdateError(
      'version-unreadable',
      `cannot order the console's release ${target} against this runner's ${current}`,
    );
  }
  if (order < 0) {
    throw new UpdateError(
      'downgrade',
      `the console names ${target}, lower than the installed ${current}; a runner is never downgraded`,
    );
  }
  if (isRunnerVersionBelow(target, minimumVersion)) {
    throw new UpdateError(
      'below-minimum',
      `the console names ${target}, below its own minimum ${minimumVersion ?? ''}; ask the console's operator`,
    );
  }
  return order === 0 ? { kind: 'current', current, target } : { kind: 'available', current, target };
}

/**
 * Whether `auto` must not move from `current` to `target`: a runner that is not on a pre-release stays off
 * pre-releases. A version that is not SemVer counts as stable, so it cannot escape the rule by being unreadable.
 */
export function isChannelMismatch(current: string, target: string): boolean {
  return runnerReleaseChannelOf(current) !== 'prerelease' && runnerReleaseChannelOf(target) !== 'stable';
}

export interface ApplyDeps {
  /** `TC_RUNNER_HOME`; the download is staged in `updates/` there, private to the runner's user. */
  readonly home: string;
  /** The install directory (the running bundle's): `team-console-runner.mjs` and `bin/`. */
  readonly prefix: string;
  readonly platform: string;
  readonly arch: string;
  readonly exec: Exec;
  /** `gh`'s environment: PATH and its own auth/config variables only, never the runner's whole env. */
  readonly ghEnv: Readonly<Record<string, string>>;
  /** The current uid, or `null` where there is none (the prefix must belong to it). */
  readonly uid: number | null;
  readonly log: (line: string) => void;
}

const SHARED_WRITE = 0o022;
const SUMS_LINE = /^([0-9a-f]{64}) [ *](.+)$/;

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

async function assertGh(deps: ApplyDeps): Promise<void> {
  const options: ExecOptions = { env: deps.ghEnv };
  let code: number | null;
  try {
    ({ code } = await deps.exec('gh', ['--version'], options));
  } catch (error: unknown) {
    if (isErrno(error, 'ENOENT')) {
      code = null;
    } else {
      throw error;
    }
  }
  if (code !== 0 && deps.uid === 0) {
    // #900: under sudo the launcher fixes PATH, so an installed Homebrew `gh` is not "missing", it is off root's PATH.
    throw new UpdateError(
      'gh-missing',
      `update as root runs \`gh\` only from root's PATH (${deps.ghEnv['PATH'] ?? 'unset'}) and could not run one there; a Homebrew \`gh\` belongs to the login user, so root does not use it. A root-owned install is updated by hand: docs/runbooks/runner.md › Update (download, gh attestation verify, sudo tar)`,
    );
  }
  if (code !== 0) {
    throw new UpdateError(
      'gh-missing',
      'update verifies a release with the GitHub CLI and could not run `gh`; install it (https://cli.github.com), run `gh auth login` as this user, then try again',
    );
  }
}

/**
 * The swap writes into the prefix as this user; a root-owned one (the `user` backend) is updated by hand. `bin` is a
 * real directory until the first update links it through `current`, and `releases/` does not exist before then.
 */
async function assertPrefixWritable(deps: ApplyDeps, target: string): Promise<void> {
  const refuse = (path: string): never => {
    throw new UpdateError(
      'prefix-not-writable',
      `${target} is available, but ${path} is not this user's to write; install it by hand as docs/runbooks/runner.md › Update says (download, gh attestation verify, sudo tar)`,
    );
  };
  const isOwnDir = (stats: Stats | null): boolean =>
    stats !== null &&
    stats.isDirectory() &&
    (deps.uid === null || stats.uid === deps.uid) &&
    (stats.mode & SHARED_WRITE) === 0;
  if (!isOwnDir(await lstatOrNull(deps.prefix))) {
    refuse(deps.prefix);
  }
  for (const name of ['bin', RELEASES_DIR]) {
    const path = join(deps.prefix, name);
    const stats = await lstatOrNull(path);
    if (stats !== null && !(name === 'bin' && stats.isSymbolicLink()) && !isOwnDir(stats)) {
      refuse(path);
    }
  }
  const current = await lstatOrNull(join(deps.prefix, CURRENT_LINK));
  if (current !== null && !current.isSymbolicLink()) {
    refuse(join(deps.prefix, CURRENT_LINK));
  }
}

/** The extracted tree must hold exactly the release files: regular files, no links, nothing extra. */
async function assertReleaseTree(tree: string): Promise<void> {
  const expected = new Set<string>([RELEASE_SUMS_FILE, 'bin', ...RELEASE_FILES]);
  const found: string[] = [];
  const walk = async (dir: string, relative: string): Promise<void> => {
    for (const name of await readdir(dir)) {
      const path = relative === '' ? name : `${relative}/${name}`;
      found.push(path);
      const stats = await lstat(join(dir, name));
      if (stats.isDirectory() && path === 'bin') {
        await walk(join(dir, name), path);
      } else if (!stats.isFile()) {
        throw new UpdateError('unpack-failed', `the release holds ${path}, which is not a regular file`);
      }
    }
  };
  await walk(tree, '');
  const extra = found.filter((path) => !expected.has(path));
  const missing = [...expected].filter((path) => !found.includes(path));
  if (extra.length > 0 || missing.length > 0) {
    throw new UpdateError(
      'unpack-failed',
      `the release does not hold the expected files (extra: ${extra.join(', ') || 'none'}; missing: ${missing.join(', ') || 'none'})`,
    );
  }
}

/** `SHA256SUMS` inside the tarball names every release file once, and each file matches it. */
async function assertSums(tree: string): Promise<void> {
  const sums = new Map<string, string>();
  for (const line of (await readFile(join(tree, RELEASE_SUMS_FILE), 'utf8')).split('\n')) {
    if (line === '') {
      continue;
    }
    const match = SUMS_LINE.exec(line);
    if (match === null || sums.has(match[2] ?? '')) {
      throw new UpdateError('verification-failed', `${RELEASE_SUMS_FILE} has a malformed or repeated line`);
    }
    sums.set(match[2] ?? '', match[1] ?? '');
  }
  if (sums.size !== RELEASE_FILES.length || !RELEASE_FILES.every((file) => sums.has(file))) {
    throw new UpdateError(
      'verification-failed',
      `${RELEASE_SUMS_FILE} does not list exactly the release files`,
    );
  }
  for (const file of RELEASE_FILES) {
    const digest = createHash('sha256')
      .update(await readFile(join(tree, file)))
      .digest('hex');
    if (digest !== sums.get(file)) {
      throw new UpdateError('verification-failed', `${file} does not match ${RELEASE_SUMS_FILE}`);
    }
  }
}

/** Points `path` (a file or a link, never a directory) at `target` with one rename over it. */
async function replaceWithLink(path: string, target: string): Promise<void> {
  const stats = await lstatOrNull(path);
  if (stats?.isSymbolicLink() === true && (await readlink(path)) === target) {
    return;
  }
  const next = `${path}.next`;
  await rm(next, { force: true });
  await symlink(target, next);
  await rename(next, path);
}

const BIN_THROUGH_CURRENT = join(CURRENT_LINK, BIN_DIR);

/**
 * `bin/` keeps one real directory and links each file through `current` (see `install-layout.ts`): `bin/job-exec`
 * exists at every step, so no crash leaves the service without it. `bin.flat` is what an earlier layout left when it
 * moved `bin` aside and was cut short; it is put back so the conversion can finish, or dropped when `bin` exists.
 */
async function linkBin(prefix: string): Promise<void> {
  const bin = join(prefix, BIN_DIR);
  const aside = `${bin}.flat`;
  let stats = await lstatOrNull(bin);
  if (stats === null && (await lstatOrNull(aside))?.isDirectory() === true) {
    await rename(aside, bin);
    stats = await lstatOrNull(bin);
  }
  await rm(aside, { recursive: true, force: true });
  if (stats?.isSymbolicLink() === true) {
    await replaceWithLink(bin, BIN_THROUGH_CURRENT);
    return;
  }
  if (stats === null) {
    await mkdir(bin, { mode: 0o755 });
  }
  for (const file of BIN_FILES) {
    await replaceWithLink(join(bin, file), binLinkTargetOf(file));
  }
}

/**
 * Sums, then `bin/`, then `node`, then the bundle: a crash anywhere leaves a runnable prefix and the next `update`
 * finishes it. Once converted, every entry resolves through `current`, so later switches move them all at once.
 */
async function linkEntries(prefix: string): Promise<void> {
  await replaceWithLink(join(prefix, SUMS_LINK[0]), SUMS_LINK[1]);
  await linkBin(prefix);
  await replaceWithLink(join(prefix, NODE_LINK[0]), NODE_LINK[1]);
  await replaceWithLink(join(prefix, BUNDLE_LINK[0]), BUNDLE_LINK[1]);
}

/** Whether every entry already links through `current`; an unfinished conversion does not. */
async function isFullyLinked(prefix: string): Promise<boolean> {
  const linksTo = async (path: string, target: string): Promise<boolean> => {
    const stats = await lstatOrNull(path);
    return stats?.isSymbolicLink() === true && (await readlink(path)) === target;
  };
  for (const [name, target] of [SUMS_LINK, NODE_LINK, BUNDLE_LINK]) {
    if (!(await linksTo(join(prefix, name), target))) {
      return false;
    }
  }
  const bin = join(prefix, BIN_DIR);
  if (await linksTo(bin, BIN_THROUGH_CURRENT)) {
    return true;
  }
  for (const file of BIN_FILES) {
    if (!(await linksTo(join(bin, file), binLinkTargetOf(file)))) {
      return false;
    }
  }
  return true;
}

/** The version `current` names, or `null` in a flat prefix. */
export async function liveReleaseOf(prefix: string): Promise<string | null> {
  const current = join(prefix, CURRENT_LINK);
  return (await lstatOrNull(current))?.isSymbolicLink() === true ? basename(await readlink(current)) : null;
}

/**
 * The release is copied whole into `releases/<target>` (renamed into place once complete), then `current` is renamed
 * onto it: that one rename is the switch. Only the new release and the one it replaced are kept.
 */
async function swapInto(tree: string, prefix: string, target: string): Promise<void> {
  const live = await liveReleaseOf(prefix);
  if (live === target) {
    // A conversion that crashed after `current` named the target: finish it instead of refusing for ever.
    if (!(await isFullyLinked(prefix))) {
      await linkEntries(prefix);
      return;
    }
    throw new UpdateError(
      'unpack-failed',
      `${releaseDirOf(target)} is the live release; nothing was changed`,
    );
  }
  const releases = join(prefix, RELEASES_DIR);
  await mkdir(releases, { recursive: true, mode: 0o755 });
  const destination = join(prefix, releaseDirOf(target));
  const staged = `${destination}.partial`;
  await rm(staged, { recursive: true, force: true });
  await rm(destination, { recursive: true, force: true });
  await mkdir(join(staged, 'bin'), { recursive: true, mode: 0o755 });
  for (const file of RELEASE_FILES) {
    await copyFile(join(tree, file), join(staged, file));
    await chmod(join(staged, file), 0o555);
  }
  await copyFile(join(tree, RELEASE_SUMS_FILE), join(staged, RELEASE_SUMS_FILE));
  await chmod(join(staged, RELEASE_SUMS_FILE), 0o444);
  await rename(staged, destination);
  await replaceWithLink(join(prefix, CURRENT_LINK), releaseDirOf(target));
  await linkEntries(prefix);
  const keep = new Set([target, live]);
  for (const name of await readdir(releases)) {
    if (!keep.has(name)) {
      await rm(join(releases, name), { recursive: true, force: true });
    }
  }
}

/**
 * Unpacks a tarball whose bytes were already verified into `staging/tree`, checks the tree and its sums, confirms the
 * bundle reports `target` when run by the release's own `node` (so a node that does not run on this host is refused
 * before the switch), then switches `prefix` to it. Shared by `update` (after `gh attestation verify`) and by
 * `setup --release` (after the root-owned copy matched the sum the console named, R-ONE-1).
 */
export async function installTarball(
  tarball: string,
  staging: string,
  prefix: string,
  target: string,
  deps: Pick<ApplyDeps, 'exec'>,
): Promise<void> {
  const tree = join(staging, 'tree');
  await mkdir(tree, { mode: 0o700 });
  const unpacked = await deps.exec('tar', ['-xzf', tarball, '--no-same-owner', '-C', tree]);
  if (unpacked.code !== 0) {
    throw new UpdateError(
      'unpack-failed',
      `tar could not extract ${basename(tarball)} (exit ${String(unpacked.code)})`,
    );
  }
  await assertReleaseTree(tree);
  await assertSums(tree);
  const reported = await deps.exec(join(tree, NODE_FILE), [
    '--disable-sigusr1',
    join(tree, BUNDLE_FILE),
    'version',
  ]);
  if (reported.code !== 0 || reported.stdout.trim() !== target) {
    throw new UpdateError('verification-failed', `the downloaded bundle does not report version ${target}`);
  }
  await swapInto(tree, prefix, target);
}

/**
 * Downloads `target` for this platform, has `gh attestation verify` check it against the pinned identity, checks the
 * tree and its sums, confirms the bundle reports `target`, then switches the prefix to it (`install-layout.ts`).
 * Nothing in the prefix changes before every check has passed; the staging directory is removed either way.
 */
export async function applyUpdate(target: string, deps: ApplyDeps): Promise<void> {
  // `target` names a directory under the prefix below; only a SemVer label may.
  if (runnerReleaseChannelOf(target) === null) {
    throw new UpdateError('version-unreadable', `${target} is not a runner release version`);
  }
  const platform = releasePlatformOf(deps.platform, deps.arch);
  if (platform === null) {
    throw new UpdateError(
      'platform-unsupported',
      `no runner release is published for ${deps.platform}-${deps.arch}`,
    );
  }
  await assertGh(deps);
  await assertPrefixWritable(deps, target);
  const updates = join(deps.home, 'updates');
  await ensurePrivateDir(updates);
  const staging = await mkdtemp(join(updates, `${target}-`));
  try {
    const asset = tarballNameOf(target, platform);
    const tarball = join(staging, asset);
    const download = await deps.exec('gh', releaseDownloadArgs(target, asset, staging), { env: deps.ghEnv });
    if (download.code !== 0 || (await lstatOrNull(tarball))?.isFile() !== true) {
      throw new UpdateError(
        'download-failed',
        `gh release download could not fetch ${asset} (exit ${String(download.code)})`,
      );
    }
    const verifyArgs = attestationVerifyArgs(tarball, target);
    const verified = await deps.exec('gh', verifyArgs, { env: deps.ghEnv });
    if (verified.code !== 0) {
      throw new UpdateError(
        'verification-failed',
        `gh attestation verify refused ${asset} (exit ${String(verified.code)}); nothing was installed. To see why: gh ${verifyArgs.join(' ')}`,
      );
    }
    deps.log(`verified ${asset}: built by the pinned release workflow from ${target}'s tag`);
    await installTarball(tarball, staging, deps.prefix, target, deps);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
