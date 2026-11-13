import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isUlid } from '@shared/contracts';
import { ensurePrivateDir, pathExists } from '../config/private-files';
import { BackendError, type JobContext, type Sandbox } from './backend';

/** `jobs/<jobId>/{home,tmp,clone,sock}` (ADR 0008 decision 2), one fresh root per job for every backend. */

export const jobsRootOf = (home: string): string => join(home, 'jobs');

/**
 * Creates the job's root (never reusing one) with `mode` and returns its paths; the backend creates what is inside.
 * `dirMode` is the mode of `jobs/` itself: 0750 when a job user must traverse it.
 */
export async function createSandboxRoot(
  home: string,
  job: JobContext,
  mode: number,
  dirMode: 0o700 | 0o750 = 0o700,
): Promise<Sandbox> {
  if (!isUlid(job.jobId)) {
    throw new BackendError('not a job id');
  }
  const jobsRoot = jobsRootOf(home);
  await ensurePrivateDir(jobsRoot, dirMode);
  const root = join(jobsRoot, job.jobId);
  if (await pathExists(root)) {
    throw new BackendError(`the sandbox of job ${job.jobId} already exists`);
  }
  await mkdir(root, { mode });
  // mkdir's mode passes through the umask; the sticky and group bits must hold exactly.
  await chmod(root, mode);
  return {
    jobId: job.jobId,
    root,
    home: join(root, 'home'),
    tmp: join(root, 'tmp'),
    clone: join(root, 'clone'),
    socketDir: join(root, 'sock'),
  };
}

/** The runner-side sandbox of `none` and `container`: everything 0700 and the runner's own. */
export async function createPrivateSandbox(home: string, job: JobContext): Promise<Sandbox> {
  const sandbox = await createSandboxRoot(home, job, 0o700);
  await mkdir(sandbox.home, { mode: 0o700 });
  await mkdir(sandbox.tmp, { mode: 0o700 });
  return sandbox;
}
