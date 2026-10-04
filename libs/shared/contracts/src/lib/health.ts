/** `local` exists only under `wrangler dev` with `--var ENVIRONMENT:local`; never in a deployed environment. */
export const ENVIRONMENTS = ['local', 'dev', 'stage', 'production'] as const;

export type Environment = (typeof ENVIRONMENTS)[number];

export function isEnvironment(value: unknown): value is Environment {
  return typeof value === 'string' && (ENVIRONMENTS as readonly string[]).includes(value);
}

/** `GET /api/v1/healthz` on the `api` Worker, which sits behind Access. */
export interface HealthDto {
  readonly status: 'ok';
  readonly environment: Environment;
  readonly version: string;
}

/** `GET /healthz` on the public `hooks` Worker: liveness only, nothing that describes the deployment. */
export interface PublicHealthDto {
  readonly status: 'ok';
}
