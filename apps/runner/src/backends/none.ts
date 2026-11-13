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

function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
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
    if (!signalGroup(running.pid, 'SIGTERM')) {
      return;
    }
    const exited = await Promise.race([
      running.exited.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), KILL_GRACE_MS).unref()),
    ]);
    // The group outlives its leader when a child ignored SIGTERM.
    signalGroup(running.pid, 'SIGKILL');
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
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
          throw error;
        }
      }
    }
    await removeTree(sandbox.root);
  }
}
