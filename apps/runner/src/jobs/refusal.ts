/**
 * Why the runner refused to launch a job (ADR 0008 decisions 4, 5, 7, 8). Each is a `failed` finish with
 * `metrics.reason`, never a silent fallback. The message names keys and variable names only, never a value.
 */
export type LaunchRefusalReason =
  | 'env-passthrough-refused'
  | 'credential-not-allowed'
  | 'credential-unreadable'
  | 'oauth-on-hosted'
  | 'git-config-refused'
  | 'repository-not-configured'
  | 'plugin-missing'
  | 'role-unknown';

export class LaunchRefusal extends Error {
  constructor(
    readonly reason: LaunchRefusalReason,
    message: string,
  ) {
    super(message);
    this.name = 'LaunchRefusal';
  }
}
