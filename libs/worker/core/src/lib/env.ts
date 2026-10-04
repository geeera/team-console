/**
 * Bindings every Worker has. Each app extends it with its own vars and secrets;
 * secrets are declared there but never appear in `wrangler.jsonc`.
 */
export interface WorkerBaseEnv {
  /** `local | dev | stage | production`; a string at runtime, validated where it is read. */
  readonly ENVIRONMENT: string;
  readonly DB: D1Database;
}
