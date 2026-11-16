import { hostExec, type Exec } from '../host/exec';
import type { IsolationBackend, JobContext, LaunchSpec, RunningJob, Sandbox } from './backend';
import { NoneBackend } from './none';

/**
 * The `actions-ephemeral` backend (#669; architect note on #573, ADR 0008 decision 7(a′)): one job on a GitHub-hosted
 * VM that GitHub discards after the run, so the VM is the isolation boundary and the process model is `none`'s — the
 * job as the runner's own user, its own process group, the sandbox swept. The rest of the sandbox is the same as on
 * every backend, applied by the job loop: a fresh HOME/TMPDIR/clone under `$RUNNER_TEMP/tc`, the env built from
 * nothing, the git-config refusals, the managed settings with every hook off. Only an OIDC exchange names this
 * backend; `enrol` never offers it.
 */
export class ActionsEphemeralBackend implements IsolationBackend {
  readonly kind = 'actions-ephemeral' as const;
  private readonly none: NoneBackend;

  constructor(home: string, exec: Exec = hostExec) {
    this.none = new NoneBackend(home, exec);
  }

  async preflight(): Promise<void> {
    await this.none.preflight();
  }

  async prepare(job: JobContext): Promise<Sandbox> {
    return await this.none.prepare(job);
  }

  async launch(sandbox: Sandbox, spec: LaunchSpec): Promise<RunningJob> {
    return await this.none.launch(sandbox, spec);
  }

  async kill(running: RunningJob): Promise<void> {
    await this.none.kill(running);
  }

  async cleanup(sandbox: Sandbox): Promise<void> {
    await this.none.cleanup(sandbox);
  }
}
