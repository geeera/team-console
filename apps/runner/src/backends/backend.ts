import type { Readable } from 'node:stream';
import type { RunnerIsolation } from '@shared/contracts';
import type { GitRunner } from '../git/git';

/**
 * How a job is isolated (ADR 0008 decision 3). The job loop is backend-agnostic: `none` (fixtures), `user` (a second
 * uid through the job-exec wrapper) and `container` (one container per job) implement the same interface.
 */

export interface JobContext {
  readonly jobId: string;
  /** `null` for a runner check (#1059): a check serves no project and prepares no clone. */
  readonly projectSlug: string | null;
}

/** The per-job directories, fresh for every job: nothing is inherited from a previous one. */
export interface Sandbox {
  readonly jobId: string;
  readonly root: string;
  readonly home: string;
  readonly tmp: string;
  readonly clone: string;
  readonly socketDir: string;
  /** The socket file's mode: 0600 unless the job runs as another user who must connect to it. */
  readonly socketMode?: number | undefined;
}

interface LaunchCommand {
  readonly command: string;
  readonly argv: readonly string[];
  /** Exactly the child's environment (`env-builder.ts`); the backend adds nothing. */
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
}

/** A job's launch: `readOnly` is required, so no job can be launched without its plugin and managed settings. */
export interface LaunchSpec extends LaunchCommand {
  readonly maxMinutes: number;
  /** What the job may read but never write; `user`/`container` mount or chown them so. */
  readonly readOnly: { readonly plugin: string; readonly managedSettings: string };
}

/**
 * A runner check's launch (#1059, S3/S6): the fixed command of its kind, nothing to mount, no plugin or settings.
 * The backend starts it with stderr discarded at spawn and, on `container`, without a network.
 */
export interface CheckLaunchSpec extends LaunchCommand {
  readonly readOnly?: never;
}

export interface ExitStatus {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** What `kill` needs of a started process; a check has no stderr to read (S6). */
export interface RunningProcess {
  readonly pid: number;
  readonly stdout: Readable;
  readonly exited: Promise<ExitStatus>;
}

export interface RunningJob extends RunningProcess {
  readonly stderr: Readable;
}

export interface IsolationBackend {
  readonly kind: RunnerIsolation;
  /** Refuses when the host is not ready: a leftover job process, wrong permissions, no runtime. */
  preflight(): Promise<void>;
  prepare(job: JobContext): Promise<Sandbox>;
  launch(sandbox: Sandbox, spec: LaunchSpec): Promise<RunningJob>;
  /**
   * A runner check's fixed command (#1059) in the same isolation as a job; absent where checks never run
   * (`actions-ephemeral`). Throws `CommandNotExecutableError` when the command cannot be started at all.
   */
  launchCheck?(sandbox: Sandbox, spec: CheckLaunchSpec): Promise<RunningProcess>;
  /** The whole process tree; used at `maxMinutes`, on a lost lease, on shutdown and at a check's time limit. */
  kill(running: RunningProcess): Promise<void>;
  /** Kills what is left of the job and wipes the sandbox. */
  cleanup(sandbox: Sandbox): Promise<void>;
  /**
   * After the CLI exited and before `finish`: kills what the job left and sweeps its stray files, returning what it
   * found as `notice` payloads so the job's own events say so (C3 cross-job row (d)).
   */
  settle?(sandbox: Sandbox): Promise<readonly Record<string, unknown>[]>;
  /** Runs the clone's git as the job's user (`user`), so the job owns its clone; absent → the runner's git. */
  readonly jobGit?: GitRunner;
  /** Mode of the runner's directories a job must read (`work/`, `plugin/`, `jobs/`): 0750 on `user`, else 0700. */
  readonly sharedDirMode?: 0o700 | 0o750;
}

export class BackendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackendError';
  }
}

/** The command does not exist or may not be executed (spawn `ENOENT`/`EACCES`): the check's `claude-not-executable`. */
export class CommandNotExecutableError extends BackendError {
  constructor(message: string) {
    super(message);
    this.name = 'CommandNotExecutableError';
  }
}
