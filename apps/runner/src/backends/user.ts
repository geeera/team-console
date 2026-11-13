import { chown, lstat, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MANAGED_SETTINGS } from '../claude/managed-settings';
import { assertPrivateDir, lstatOrNull, pathExists } from '../config/private-files';
import { GitError, type GitRunner } from '../git/git';
import { removeTree } from '../git/workspace';
import { SYSTEM_PATH, hostExec, hostSpawn, type Exec, type ExecResult, type Spawn } from '../host/exec';
import {
  BackendError,
  type IsolationBackend,
  type JobContext,
  type LaunchSpec,
  type RunningJob,
  type Sandbox,
} from './backend';
import { jobExecSpecOf } from './job-exec';
import { createSandboxRoot, jobsRootOf } from './sandbox';

/**
 * The `user` backend (ADR 0008 decisions 3 and 11, threat model L3 and C3 cross-job rows (c)–(e)): the runner is
 * `_tcrunner`, every job runs as `_tcjob` through the one sudoers rule (`sudo -u _tcjob <prefix>/bin/job-exec`).
 * Before and after every job `pkill -9 -u _tcjob` runs, and no job launches while a `_tcjob` process remains; the
 * job's stray files in the shared temp directories are swept with a `notice`. The job owns its HOME, TMPDIR and clone
 * (made as `_tcjob` in a sticky `jobs/<id>`); it reaches the runner only through `sock/` (`_tcrunner:_tcjob 0750`,
 * the socket 0660), reads the mirror and plugin through group 0750 directories, and can write nothing of the runner's.
 * Hooks stay off through the root-owned managed settings the installer puts at the CLI's managed path.
 */

export const JOB_USER = '_tcjob';
export const RUNNER_USER = '_tcrunner';
const SUDO = '/usr/bin/sudo';
const PGREP = '/usr/bin/pgrep';
const ID = '/usr/bin/id';
const SWEEP_NOTICE_PATHS = 10;

/** Where Claude Code reads managed settings it lets nothing override (decision 8). */
export const SYSTEM_MANAGED_SETTINGS_PATH = {
  darwin: '/Library/Application Support/ClaudeCode/managed-settings.json',
  linux: '/etc/claude-code/managed-settings.json',
} as const;

export const managedSettingsText = (): string => `${JSON.stringify(MANAGED_SETTINGS, null, 2)}\n`;

export interface UserBackendOptions {
  readonly home: string;
  /** `<prefix>/bin/job-exec`, the path the sudoers rule names. */
  readonly jobExec: string;
  /** The directory of the `node` that `job-exec run` starts (sudo keeps `PATH` without `secure_path`). */
  readonly nodeDir: string;
  readonly managedSettingsPath: string;
  readonly exec?: Exec;
  readonly spawn?: Spawn;
  /** The owner the managed settings must have; 0 outside specs. */
  readonly rootUid?: number;
}

export class UserBackend implements IsolationBackend {
  readonly kind = 'user' as const;
  readonly sharedDirMode = 0o750;
  private readonly exec: Exec;
  private readonly spawn: Spawn;
  private gid: number | null = null;

  constructor(private readonly options: UserBackendOptions) {
    this.exec = options.exec ?? hostExec;
    this.spawn = options.spawn ?? hostSpawn;
  }

  private get sudoEnv(): Record<string, string> {
    return { PATH: `${this.options.nodeDir}:${SYSTEM_PATH}` };
  }

  private sudoArgs(mode: 'run' | 'reap' | 'sweep'): string[] {
    return ['-n', '-u', JOB_USER, '--', this.options.jobExec, mode];
  }

  private async asJob(mode: 'reap' | 'sweep', stdin?: string): Promise<ExecResult> {
    return await this.exec(SUDO, this.sudoArgs(mode), { env: this.sudoEnv, stdin });
  }

  /** Runs one command as the job user with exactly `env`. */
  private async runAsJob(
    command: string,
    argv: readonly string[],
    env: Readonly<Record<string, string>>,
    cwd: string,
  ): Promise<ExecResult> {
    return await this.exec(SUDO, this.sudoArgs('run'), {
      env: this.sudoEnv,
      stdin: jobExecSpecOf({ command, argv, env, cwd }),
    });
  }

  readonly jobGit: GitRunner = async (args, env) => {
    const { code, stdout } = await this.runAsJob('git', args, env, '/');
    if (code !== 0) {
      throw new GitError(args.find((arg) => !arg.startsWith('-') && !arg.includes('=')) ?? 'git', code);
    }
    return stdout;
  };

  private async jobGid(): Promise<number> {
    if (this.gid === null) {
      const { code, stdout } = await this.exec(ID, ['-g', JOB_USER]);
      const gid = Number(stdout.trim());
      if (code !== 0 || !Number.isInteger(gid) || gid <= 0) {
        throw new BackendError(
          `there is no ${JOB_USER} user; run "team-console-runner install --backend user"`,
        );
      }
      this.gid = gid;
    }
    return this.gid;
  }

  private async reap(): Promise<void> {
    const { code } = await this.asJob('reap');
    // pkill: 0 killed some, 1 found none.
    if (code !== 0 && code !== 1) {
      throw new BackendError(
        `sudo -u ${JOB_USER} job-exec reap exited ${String(code)}; check the sudoers rule`,
      );
    }
  }

  private async remaining(): Promise<number[]> {
    const { code, stdout } = await this.exec(PGREP, ['-u', JOB_USER]);
    if (code !== 0 && code !== 1) {
      throw new BackendError(`pgrep exited ${String(code)}`);
    }
    return stdout
      .split('\n')
      .filter((line) => /^\d+$/.test(line.trim()))
      .map(Number);
  }

  private async sweep(): Promise<string[]> {
    const { code, stdout } = await this.asJob('sweep');
    if (code !== 0) {
      throw new BackendError(`sudo -u ${JOB_USER} job-exec sweep exited ${String(code)}`);
    }
    return stdout.split('\n').filter((line) => line !== '');
  }

  /** The job's own entries of `root` go as the job user (the runner may not delete them), the rest as the runner. */
  private async wipe(root: string): Promise<void> {
    const env = { PATH: SYSTEM_PATH };
    for (const action of [
      ['-exec', '/bin/chmod', '-R', 'u+rwX', '{}', '+'],
      ['-exec', '/bin/rm', '-rf', '{}', '+'],
    ]) {
      const args = [root, '-mindepth', '1', '-maxdepth', '1', '-user', JOB_USER, ...action];
      const { code } = await this.runAsJob('/usr/bin/find', args, env, '/');
      if (code !== 0) {
        throw new BackendError(`could not remove the job's files in ${root} (exit ${String(code)})`);
      }
    }
    await removeTree(root);
  }

  /** Decision 8 and the SECURITY note on #589: root-owned, writable by root only, exactly the runner's settings. */
  private async assertManagedSettings(): Promise<void> {
    const path = this.options.managedSettingsPath;
    const stats = await lstatOrNull(path);
    const refuse = (why: string): never => {
      throw new BackendError(`${path} ${why}; run "team-console-runner install --backend user"`);
    };
    if (stats === null || !stats.isFile()) {
      return refuse('is missing');
    }
    if (stats.uid !== (this.options.rootUid ?? 0) || (stats.mode & 0o022) !== 0) {
      return refuse('must be root-owned and writable by root only');
    }
    if ((await readFile(path, 'utf8')) !== managedSettingsText()) {
      refuse('is not the runner’s managed settings');
    }
  }

  async preflight(): Promise<void> {
    await this.assertManagedSettings();
    const { home } = this.options;
    await assertPrivateDir(home);
    const stats = await lstat(home);
    if (stats.gid !== (await this.jobGid()) || (stats.mode & 0o050) !== 0o050) {
      throw new BackendError(`${home} must be ${RUNNER_USER}:${JOB_USER} 0750 (the installer sets it)`);
    }
    await this.reap();
    const left = await this.remaining();
    if (left.length > 0) {
      throw new BackendError(
        `a ${JOB_USER} process is still running (pid ${left.join(', ')}); no job starts`,
      );
    }
    await this.sweep();
    const jobsRoot = jobsRootOf(home);
    // A sandbox left by a crash: its job is gone, so it is wiped before any new job starts.
    for (const entry of (await pathExists(jobsRoot)) ? await readdir(jobsRoot) : []) {
      await this.wipe(join(jobsRoot, entry));
    }
  }

  async prepare(job: JobContext): Promise<Sandbox> {
    const gid = await this.jobGid();
    // Sticky and group-writable: the job user creates its own HOME, TMPDIR and clone here but cannot touch `sock/`.
    const sandbox = await createSandboxRoot(this.options.home, job, 0o1770, 0o750);
    const uid = process.getuid?.() ?? -1;
    await chown(sandbox.root, uid, gid);
    await mkdir(sandbox.socketDir, { mode: 0o750 });
    await chown(sandbox.socketDir, uid, gid);
    const made = await this.runAsJob(
      '/bin/mkdir',
      ['-m', '700', sandbox.home, sandbox.tmp],
      { PATH: SYSTEM_PATH },
      sandbox.root,
    );
    if (made.code !== 0) {
      throw new BackendError(`could not create the job's HOME and TMPDIR as ${JOB_USER}`);
    }
    return { ...sandbox, socketMode: 0o660 };
  }

  async launch(_sandbox: Sandbox, spec: LaunchSpec): Promise<RunningJob> {
    const child = await this.spawn(SUDO, this.sudoArgs('run'), {
      env: this.sudoEnv,
      stdin: jobExecSpecOf(spec),
    });
    if (child.pid === undefined) {
      throw new BackendError(`could not start sudo -u ${JOB_USER}`);
    }
    return { pid: child.pid, stdout: child.stdout, stderr: child.stderr, exited: child.exited };
  }

  async kill(running: RunningJob): Promise<void> {
    await this.reap();
    await running.exited;
  }

  async settle(): Promise<readonly Record<string, unknown>[]> {
    await this.reap();
    const swept = await this.sweep();
    return swept.length === 0
      ? []
      : [{ sweep: 'removed', count: swept.length, paths: swept.slice(0, SWEEP_NOTICE_PATHS) }];
  }

  async cleanup(sandbox: Sandbox): Promise<void> {
    await this.reap();
    await this.wipe(sandbox.root);
    await this.sweep();
    const left = await this.remaining();
    if (left.length > 0) {
      throw new BackendError(`a ${JOB_USER} process survived the job (pid ${left.join(', ')})`);
    }
  }
}
