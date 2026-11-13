import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ensurePrivateDir, pathExists } from '../config/private-files';
import { LaunchRefusal } from '../jobs/refusal';
import { assertCleanGitConfig } from './git-config';
import { runGit, type GitRunner } from './git';

/**
 * The job's code (ADR 0008 decisions 2 and 7, threat model C3 row (b), C4 "vendored plugin swapped"): a bare mirror
 * per project under `work/<slug>/mirror`, fetched by the runner before each job; a fresh clone per job copied from it
 * (no hardlinks, no templates, so no hook comes along); and the product-team plugin taken from the default branch
 * into `plugin/<tree>/`, read-only and outside the clone, so a job cannot swap what the next job runs.
 */

export const PLUGIN_PATH_IN_REPO = '.claude/product-team';
const TREE_ID = /^[0-9a-f]{40,64}$/;

export interface GitEnvs {
  /** The runner's git env: the mirror fetch may use the runner's own read access. */
  readonly runner: Readonly<Record<string, string>>;
  /** The env a job's git would see (fresh HOME): config is judged and the clone made with it. */
  readonly job: Readonly<Record<string, string>>;
  /** Runs the clone's git as the job's user (the `user` backend); absent → the runner's own git. */
  readonly jobGit?: GitRunner | undefined;
  /** 0750 when a job user must read the mirror (the `user` backend); else 0700. */
  readonly dirMode?: 0o700 | 0o750 | undefined;
}

export const mirrorPathOf = (home: string, slug: string): string => join(home, 'work', slug, 'mirror');

/** Hooks a git command would run; the mirror and the clone are made without templates, so any file here is planted. */
async function assertNoHooks(hooksDir: string): Promise<void> {
  if (!(await pathExists(hooksDir))) {
    return;
  }
  const planted = (await readdir(hooksDir)).filter((name) => !name.endsWith('.sample'));
  if (planted.length > 0) {
    throw new LaunchRefusal('git-config-refused', `hooks present in ${hooksDir}: ${planted.join(', ')}`);
  }
}

/** Creates or fetches the project's bare mirror; refuses it when its config or hooks were tampered with. */
export async function syncMirror(home: string, slug: string, url: string, envs: GitEnvs): Promise<string> {
  const mirror = mirrorPathOf(home, slug);
  await ensurePrivateDir(join(home, 'work'), envs.dirMode);
  await ensurePrivateDir(join(home, 'work', slug), envs.dirMode);
  if (await pathExists(mirror)) {
    // Judged before the fetch too: a planted hook or fsmonitor would run inside it.
    await assertNoHooks(join(mirror, 'hooks'));
    await assertCleanGitConfig(mirror, envs.job, null);
    await runGit(['--git-dir', mirror, 'fetch', '--prune', '--quiet', 'origin'], envs.runner);
  } else {
    await runGit(['clone', '--mirror', '--quiet', '--template=', '--', url, mirror], envs.runner);
  }
  await assertNoHooks(join(mirror, 'hooks'));
  await assertCleanGitConfig(mirror, envs.job, null);
  return mirror;
}

/** A fresh clone for one job, its `origin` the upstream URL (the job never learns the mirror's path). */
export async function cloneForJob(
  mirror: string,
  clone: string,
  upstream: string,
  envs: GitEnvs,
): Promise<void> {
  const git = envs.jobGit ?? runGit;
  // A mirror owned by another uid (the runner, on `user`) is cloned only when named safe on the command line.
  await git(
    [
      '-c',
      `safe.directory=${mirror}`,
      'clone',
      '--no-hardlinks',
      '--quiet',
      '--template=',
      '--',
      mirror,
      clone,
    ],
    envs.job,
  );
  await git(['-C', clone, 'remote', 'set-url', 'origin', upstream], envs.job);
  await assertNoHooks(join(clone, '.git', 'hooks'));
  await assertCleanGitConfig(join(clone, '.git'), envs.job, null, git);
}

async function setTreeMode(path: string, writable: boolean): Promise<void> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) {
    return;
  }
  if (stats.isDirectory()) {
    await chmod(path, writable ? 0o755 : 0o555);
    for (const entry of await readdir(path)) {
      await setTreeMode(join(path, entry), writable);
    }
    return;
  }
  const executable = (stats.mode & 0o111) !== 0;
  await chmod(path, writable ? 0o644 | (executable ? 0o111 : 0) : executable ? 0o555 : 0o444);
}

/** Removes a tree the runner made read-only. */
export async function removeTree(path: string): Promise<void> {
  if (!(await pathExists(path))) {
    return;
  }
  await setTreeMode(path, true);
  await rm(path, { recursive: true, force: true });
}

function untar(archive: string, into: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xf', archive, '-C', into], {
      stdio: 'ignore',
      env: { PATH: '/usr/bin:/bin' },
    });
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${String(code)}`))));
  });
}

/**
 * Extracts `.claude/product-team` of the default branch into `plugin/<tree>/`, re-extracted on every job so a
 * tampered copy never survives, and makes it read-only. Returns its path.
 */
export async function vendorPlugin(
  home: string,
  mirror: string,
  env: Readonly<Record<string, string>>,
  dirMode: 0o700 | 0o750 | undefined = 0o700,
): Promise<string> {
  // `<mode> tree <id>\t<path>` for a directory; nothing when the default branch has no such tree.
  const listing = await runGit(
    ['--git-dir', mirror, 'ls-tree', '-d', 'HEAD', '--', PLUGIN_PATH_IN_REPO],
    env,
  );
  const tree = /^040000 tree ([0-9a-f]+)\t/.exec(listing)?.[1] ?? '';
  if (!TREE_ID.test(tree)) {
    throw new LaunchRefusal('plugin-missing', `the default branch has no ${PLUGIN_PATH_IN_REPO}`);
  }
  const pluginRoot = join(home, 'plugin');
  await ensurePrivateDir(pluginRoot, dirMode);
  const target = join(pluginRoot, tree);
  const archive = join(pluginRoot, `${tree}.tar`);
  await removeTree(target);
  await rm(archive, { force: true });
  await mkdir(target, { mode: 0o755 });
  try {
    await runGit(['--git-dir', mirror, 'archive', '--format=tar', `--output=${archive}`, tree], env);
    await untar(archive, target);
  } finally {
    await rm(archive, { force: true });
  }
  await setTreeMode(target, false);
  return target;
}
