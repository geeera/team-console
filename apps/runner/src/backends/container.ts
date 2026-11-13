import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ContainerSettings } from '../config/config';
import { pathExists } from '../config/private-files';
import { CONTAINER_CLAUDE_CONFIG_DIR, type CredentialConfig } from '../env/credential';
import { removeTree } from '../git/workspace';
import { hostExec, hostSpawn, type Exec, type Spawn } from '../host/exec';
import {
  BackendError,
  type IsolationBackend,
  type JobContext,
  type LaunchSpec,
  type RunningJob,
  type Sandbox,
} from './backend';
import { jobExecSpecOf } from './job-exec';
import { createPrivateSandbox, jobsRootOf } from './sandbox';

/**
 * The `container` backend (ADR 0008 decision 12, threat model C3 cross-job rows and L4): one container per job from
 * the runner's image pinned by digest, `--rm`, a read-only root, HOME/TMPDIR/`/tmp` on tmpfs (gone with the
 * container), and bind mounts of exactly: the clone (the only writable one), the socket directory, the plugin, the
 * managed settings and, for `claude-config-dir`, the customer's Claude config (all read-only). `TC_RUNNER_HOME` is
 * never mounted. Paths keep their host names inside, so the env the runner built holds as it is; the env itself
 * travels on stdin to `job-exec run`, never in `docker run -e` (argv, `docker inspect`).
 */

export const JOB_LABEL = 'com.team-console.job';
export const CONTAINER_JOB_EXEC = '/opt/team-console-runner/bin/job-exec';
const DEFAULT_PIDS_LIMIT = 512;
const DEFAULT_MEMORY_MB = 4096;
const TMPFS = 'rw,nosuid,nodev';

export interface ContainerBackendOptions {
  readonly home: string;
  readonly settings: ContainerSettings | undefined;
  readonly credential: CredentialConfig | undefined;
  /** The runtime CLI's env: `PATH`, `HOME` and the `DOCKER_*` that pick its daemon; nothing reaches a job. */
  readonly runtimeEnv: Readonly<Record<string, string>>;
  readonly uid: number;
  readonly gid: number;
  readonly exec?: Exec;
  readonly spawn?: Spawn;
}

export const containerNameOf = (jobId: string): string => `tc-job-${jobId.toLowerCase()}`;

function bind(source: string, readOnly: boolean, target = source): string[] {
  // `--mount` splits on commas; a path with one would be read as options.
  if ([source, target].some((path) => path.includes(',') || !path.startsWith('/'))) {
    throw new BackendError(`cannot mount ${source}: the path must be absolute and hold no comma`);
  }
  return ['--mount', `type=bind,src=${source},dst=${target}${readOnly ? ',readonly' : ''}`];
}

export class ContainerBackend implements IsolationBackend {
  readonly kind = 'container' as const;
  private readonly exec: Exec;
  private readonly spawn: Spawn;
  private readonly runtime: string;
  private readonly running = new Map<number, string>();

  constructor(private readonly options: ContainerBackendOptions) {
    this.exec = options.exec ?? hostExec;
    this.spawn = options.spawn ?? hostSpawn;
    this.runtime = options.settings?.runtime ?? 'docker';
  }

  private async runtimeCall(args: readonly string[]): Promise<{ code: number | null; stdout: string }> {
    return await this.exec(this.runtime, args, { env: this.options.runtimeEnv });
  }

  private async containersOf(filter: string): Promise<string[]> {
    const { code, stdout } = await this.runtimeCall(['ps', '-aq', '--filter', `label=${filter}`]);
    if (code !== 0) {
      throw new BackendError(`${this.runtime} ps exited ${String(code)}`);
    }
    return stdout.split('\n').filter((line) => /^[0-9a-f]{12,64}$/.test(line.trim()));
  }

  async preflight(): Promise<void> {
    if (this.options.settings === undefined) {
      throw new BackendError('config.json has no container.image (an image pinned by digest)');
    }
    if (this.options.uid === 0) {
      throw new BackendError(
        'the container backend never runs a job as root; run the runner as a normal user',
      );
    }
    if ((await this.runtimeCall(['version'])).code !== 0) {
      throw new BackendError(`${this.runtime} is not installed or its daemon is not running`);
    }
    const left = await this.containersOf(JOB_LABEL);
    if (left.length > 0 && (await this.runtimeCall(['rm', '-f', ...left])).code !== 0) {
      throw new BackendError(`a previous job's container could not be removed (${left.join(', ')})`);
    }
    if ((await this.containersOf(JOB_LABEL)).length > 0) {
      throw new BackendError("a previous job's container is still there; no job starts");
    }
    const jobsRoot = jobsRootOf(this.options.home);
    for (const entry of (await pathExists(jobsRoot)) ? await readdir(jobsRoot) : []) {
      await removeTree(join(jobsRoot, entry));
    }
  }

  async prepare(job: JobContext): Promise<Sandbox> {
    return await createPrivateSandbox(this.options.home, job);
  }

  /** The `run` arguments of one job; public so the spec asserts the mount list exactly. */
  runArgs(sandbox: Sandbox, spec: LaunchSpec): string[] {
    const { settings, credential, uid, gid } = this.options;
    if (settings === undefined) {
      throw new BackendError('config.json has no container.image');
    }
    const owned = `${TMPFS},mode=0700,uid=${String(uid)},gid=${String(gid)}`;
    return [
      'run',
      '--interactive',
      '--rm',
      '--name',
      containerNameOf(sandbox.jobId),
      '--label',
      `${JOB_LABEL}=${sandbox.jobId}`,
      '--user',
      `${String(uid)}:${String(gid)}`,
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--network',
      settings.network ?? 'bridge',
      '--pids-limit',
      String(settings.pidsLimit ?? DEFAULT_PIDS_LIMIT),
      '--memory',
      `${String(settings.memoryMb ?? DEFAULT_MEMORY_MB)}m`,
      '--tmpfs',
      `/tmp:${TMPFS},mode=1777`,
      '--tmpfs',
      `${sandbox.home}:${owned}`,
      '--tmpfs',
      `${sandbox.tmp}:${owned}`,
      ...bind(sandbox.clone, false),
      ...bind(sandbox.socketDir, true),
      ...bind(spec.readOnly.plugin, true),
      ...bind(spec.readOnly.managedSettings, true),
      ...(credential?.kind === 'claude-config-dir'
        ? bind(credential.path, true, CONTAINER_CLAUDE_CONFIG_DIR)
        : []),
      '--workdir',
      spec.cwd,
      '--entrypoint',
      CONTAINER_JOB_EXEC,
      settings.image,
      'run',
    ];
  }

  async launch(sandbox: Sandbox, spec: LaunchSpec): Promise<RunningJob> {
    const child = await this.spawn(this.runtime, this.runArgs(sandbox, spec), {
      env: this.options.runtimeEnv,
      stdin: jobExecSpecOf(spec),
    });
    if (child.pid === undefined) {
      throw new BackendError(`could not start ${this.runtime} run`);
    }
    this.running.set(child.pid, containerNameOf(sandbox.jobId));
    return { pid: child.pid, stdout: child.stdout, stderr: child.stderr, exited: child.exited };
  }

  async kill(running: RunningJob): Promise<void> {
    const name = this.running.get(running.pid);
    if (name !== undefined) {
      // Exit 1 when the container already ended; cleanup proves it is gone.
      await this.runtimeCall(['kill', name]);
    }
    await running.exited;
  }

  async cleanup(sandbox: Sandbox): Promise<void> {
    for (const [pid, name] of this.running) {
      if (name === containerNameOf(sandbox.jobId)) {
        this.running.delete(pid);
      }
    }
    const filter = `${JOB_LABEL}=${sandbox.jobId}`;
    const left = await this.containersOf(filter);
    if (left.length > 0) {
      await this.runtimeCall(['rm', '-f', ...left]);
      if ((await this.containersOf(filter)).length > 0) {
        throw new BackendError(`the container of job ${sandbox.jobId} could not be removed`);
      }
    }
    await removeTree(sandbox.root);
  }
}
