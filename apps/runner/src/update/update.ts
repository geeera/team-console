import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { compareRunnerVersions, isRunnerVersionBelow, type RunnerReleaseDto } from '@shared/contracts';
import type { UpdatePolicy } from '../config/config';
import { ensurePrivateDir, lstatOrNull } from '../config/private-files';
import type { Exec, ExecOptions } from '../host/exec';
import {
  BUNDLE_FILE,
  RELEASE_FILES,
  RELEASE_SUMS_FILE,
  attestationVerifyArgs,
  releaseDownloadArgs,
  releasePlatformOf,
  tarballNameOf,
} from './release-identity';

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

export interface ApplyDeps {
  /** `TC_RUNNER_HOME`; the download is staged in `updates/` there, private to the runner's user. */
  readonly home: string;
  /** The install directory (the running bundle's): `team-console-runner.mjs` and `bin/`. */
  readonly prefix: string;
  readonly platform: string;
  readonly arch: string;
  /** The Node that runs the runner; it reads the new bundle's version before the swap. */
  readonly node: string;
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
  if (code !== 0) {
    throw new UpdateError(
      'gh-missing',
      'update verifies a release with the GitHub CLI and could not run `gh`; install it (https://cli.github.com), run `gh auth login` as this user, then try again',
    );
  }
}

/** The swap writes into the prefix as this user; a root-owned one (the `user` backend) is updated by hand. */
async function assertPrefixWritable(deps: ApplyDeps, target: string): Promise<void> {
  for (const path of [deps.prefix, join(deps.prefix, 'bin')]) {
    const stats = await lstatOrNull(path);
    const writable =
      stats !== null &&
      stats.isDirectory() &&
      (deps.uid === null || stats.uid === deps.uid) &&
      (stats.mode & SHARED_WRITE) === 0;
    if (!writable) {
      throw new UpdateError(
        'prefix-not-writable',
        `${target} is available, but ${path} is not this user's to write; install it by hand as docs/runbooks/runner.md › Update says (download, gh attestation verify, sudo tar)`,
      );
    }
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
    throw new UpdateError('verification-failed', `${RELEASE_SUMS_FILE} does not list exactly the release files`);
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

/** Each file lands as a sibling first and is renamed over the old one; the bundle goes last. */
async function swapInto(tree: string, prefix: string): Promise<void> {
  await mkdir(join(prefix, 'bin'), { recursive: true });
  const order = [...RELEASE_FILES.filter((file) => file !== BUNDLE_FILE), BUNDLE_FILE];
  for (const file of order) {
    const destination = join(prefix, file);
    const staged = `${destination}.update`;
    await rm(staged, { force: true });
    await copyFile(join(tree, file), staged);
    await chmod(staged, 0o555);
    await rename(staged, destination);
  }
}

/**
 * Downloads `target` for this platform, has `gh attestation verify` check it against the pinned identity, checks the
 * tree and its sums, confirms the bundle reports `target`, then swaps it into the prefix. Nothing in the prefix
 * changes before every check has passed; the staging directory is removed either way.
 */
export async function applyUpdate(target: string, deps: ApplyDeps): Promise<void> {
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
    const tree = join(staging, 'tree');
    await mkdir(tree, { mode: 0o700 });
    const unpacked = await deps.exec('tar', ['-xzf', tarball, '--no-same-owner', '-C', tree]);
    if (unpacked.code !== 0) {
      throw new UpdateError('unpack-failed', `tar could not extract ${asset} (exit ${String(unpacked.code)})`);
    }
    await assertReleaseTree(tree);
    await assertSums(tree);
    const reported = await deps.exec(deps.node, [join(tree, BUNDLE_FILE), 'version']);
    if (reported.code !== 0 || reported.stdout.trim() !== target) {
      throw new UpdateError('verification-failed', `the downloaded bundle does not report version ${target}`);
    }
    await swapInto(tree, deps.prefix);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
