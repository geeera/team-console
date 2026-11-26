import { spawn } from 'node:child_process';
import { readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { ensurePrivateDir, pathExists } from '../config/private-files';
import { removeTree } from '../git/workspace';
import { hostExec, type Exec } from '../host/exec';
import {
  BackendError,
  type ExitStatus,
  type IsolationBackend,
  type JobContext,
  type LaunchSpec,
  type RunningJob,
  type Sandbox,
} from './backend';
import { createPrivateSandbox, jobsRootOf } from './sandbox';

/**
 * The `none` backend (ADR 0008 decision 3): the job runs as the runner's own user — fixtures and local development
 * only; the console refuses its claims in production. What it does give: a fresh HOME/TMPDIR/clone per job wiped
 * afterwards, exactly the built env, its own process group killed as a whole, and a sweep of any process still
 * sitting in the sandbox (a detached one escapes the group). A process that leaves the sandbox and closes it behind
 * itself is out of reach without a second uid — that is the `user` backend's `pkill -u` (2-B-3).
 */

const KILL_GRACE_MS = 3_000;

/**
 * `ESRCH`: nothing at that pid (or process group) any more — nothing here is ours to touch, so it is "not
 * found" to every caller below. `EPERM`: something is, but the signal was refused; two different causes share
 * this code and `kill()` tells them apart instead of folding both into "gone":
 *  - the pid recycled for an unrelated process of another user between our grace period and the next signal
 *    (#702) — that process is not ours either, so this is "not found" too;
 *  - every remaining member of *our own* job's group changed uid (e.g. a sudo/setuid child, #720) — the job
 *    is still there and still running, just unsignalable, and must not be reported as finished.
 * This does *not* cover the pid being recycled for a process of our own uid: that send would succeed with no
 * error at all, and no error code can tell it apart from the real target — the liveness check right before
 * SIGKILL narrows that window instead of trying to detect it.
 */
function isGone(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH';
}

function isRefused(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EPERM';
}

type SignalOutcome = 'signalled' | 'gone' | 'refused';

function signalGroup(pid: number, signal: NodeJS.Signals): SignalOutcome {
  try {
    process.kill(-pid, signal);
    return 'signalled';
  } catch (error: unknown) {
    if (isGone(error)) {
      return 'gone';
    }
    if (isRefused(error)) {
      return 'refused';
    }
    throw error;
  }
}

/** Whether the process group `pid` names still has a member, checked with signal 0: no delivery, no side effect. */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error: unknown) {
    if (isGone(error) || isRefused(error)) {
      return false;
    }
    throw error;
  }
}

export class NoneBackend implements IsolationBackend {
  readonly kind = 'none' as const;
  private readonly jobsRoot: string;

  constructor(
    private readonly home: string,
    private readonly exec: Exec = hostExec,
  ) {
    this.jobsRoot = jobsRootOf(home);
  }

  /** Pids whose working directory is inside `dir` (`lsof`, present on macOS and the CI image). */
  async processesUnder(dir: string): Promise<number[]> {
    if (!(await pathExists(dir))) {
      return [];
    }
    const real = await realpath(dir);
    const { code, stdout } = await this.exec('lsof', ['-n', '-P', '-w', '-d', 'cwd', '-F', 'pn']);
    if (code !== 0 && code !== 1) {
      throw new BackendError(`lsof exited ${String(code)}`);
    }
    const pids: number[] = [];
    let pid = 0;
    for (const line of stdout.split('\n')) {
      if (line.startsWith('p')) {
        pid = Number(line.slice(1));
      } else if (line.startsWith('n') && pid !== process.pid) {
        const path = line.slice(1);
        if (path === real || path.startsWith(`${real}/`)) {
          pids.push(pid);
        }
      }
    }
    return [...new Set(pids)];
  }

  async preflight(): Promise<void> {
    await ensurePrivateDir(this.jobsRoot);
    const left = await this.processesUnder(this.jobsRoot);
    if (left.length > 0) {
      throw new BackendError(
        `a previous job's process is still running (pid ${left.join(', ')}); stop it first`,
      );
    }
    for (const entry of await readdir(this.jobsRoot)) {
      // A sandbox left by a crash: its job is gone, so it is wiped before any new job starts.
      await removeTree(join(this.jobsRoot, entry));
    }
  }

  async prepare(job: JobContext): Promise<Sandbox> {
    return await createPrivateSandbox(this.home, job);
  }

  async launch(_sandbox: Sandbox, spec: LaunchSpec): Promise<RunningJob> {
    const child = spawn(spec.command, [...spec.argv], {
      cwd: spec.cwd,
      env: { ...spec.env },
      // Its own process group, so `kill(-pid)` reaches every child that did not detach itself.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = new Promise<ExitStatus>((resolve) => {
      child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
      child.once('error', () => resolve({ exitCode: null, signal: null }));
    });
    await new Promise<void>((resolve) => {
      child.once('spawn', resolve);
      child.once('error', () => resolve());
    });
    if (child.pid === undefined) {
      throw new BackendError(`could not start ${spec.command}`);
    }
    return { pid: child.pid, stdout: child.stdout, stderr: child.stderr, exited };
  }

  async kill(running: RunningJob): Promise<void> {
    const sent = signalGroup(running.pid, 'SIGTERM');
    if (sent === 'gone') {
      return;
    }
    if (sent === 'refused') {
      // Every member of the group refused the signal (#720): unlike a recycled, unrelated pid, this is the
      // job we spawned, still running and now unsignalable — report it instead of treating it as finished.
      throw new BackendError(
        `job ${String(running.pid)}'s process group refused SIGTERM (EPERM); it may still be running`,
      );
    }
    const exited = await Promise.race([
      running.exited.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), KILL_GRACE_MS).unref()),
    ]);
    // The group outlives its leader when a child ignored SIGTERM, so a SIGKILL still follows — but only while
    // the group is still there: the liveness check right here, as close to the signal as this call allows,
    // narrows (it cannot close) the window in which the pid gets recycled between the grace period and the
    // SIGKILL (#702).
    if (groupAlive(running.pid)) {
      signalGroup(running.pid, 'SIGKILL');
    }
    if (!exited) {
      await running.exited;
    }
  }

  async cleanup(sandbox: Sandbox): Promise<void> {
    for (const pid of await this.processesUnder(sandbox.root)) {
      signalGroup(pid, 'SIGKILL');
      try {
        process.kill(pid, 'SIGKILL');
      } catch (error: unknown) {
        // A swept pid is not necessarily one we spawned (it only shares the sandbox dir), so both "gone" and
        // "refused" are expected here and swallowed, unlike the job's own group in `kill()` above.
        if (!isGone(error) && !isRefused(error)) {
          throw error;
        }
      }
    }
    await removeTree(sandbox.root);
  }
}
