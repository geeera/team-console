import type { Readable } from 'node:stream';
import type { RunnerIsolation } from '@shared/contracts';

/**
 * How a job is isolated (ADR 0008 decision 3). The job loop is backend-agnostic; `none` (fixtures) lives here,
 * `user` and `container` arrive in 2-B-3 against the same interface.
 */

export interface JobContext {
  readonly jobId: string;
  readonly projectSlug: string;
}

/** The per-job directories, fresh for every job: nothing is inherited from a previous one. */
export interface Sandbox {
  readonly jobId: string;
  readonly root: string;
  readonly home: string;
  readonly tmp: string;
  readonly clone: string;
  readonly socketDir: string;
}

export interface LaunchSpec {
  readonly command: string;
  readonly argv: readonly string[];
  /** Exactly the job's environment (`env-builder.ts`); the backend adds nothing. */
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly maxMinutes: number;
  /** What the job may read but never write; `user`/`container` mount or chown them so. */
  readonly readOnly: { readonly plugin: string; readonly managedSettings: string };
}

export interface ExitStatus {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface RunningJob {
  readonly pid: number;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exited: Promise<ExitStatus>;
}

export interface IsolationBackend {
  readonly kind: RunnerIsolation;
  /** Refuses when the host is not ready: a leftover job process, wrong permissions, no runtime. */
  preflight(): Promise<void>;
  prepare(job: JobContext): Promise<Sandbox>;
  launch(sandbox: Sandbox, spec: LaunchSpec): Promise<RunningJob>;
  /** The whole process tree; used at `maxMinutes`, on a lost lease and on shutdown. */
  kill(running: RunningJob): Promise<void>;
  /** Kills what is left of the job and wipes the sandbox. */
  cleanup(sandbox: Sandbox): Promise<void>;
}

export class BackendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackendError';
  }
}
