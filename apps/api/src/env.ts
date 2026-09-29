import type { WorkerBaseEnv } from '@worker/core';

/** Bindings of the `api` Worker. Vars are in wrangler.jsonc; secrets only in `wrangler secret`. */
export interface ApiEnv extends WorkerBaseEnv {
  readonly ASSETS: Fetcher;
  /** Secret (`wrangler secret put`, #7/#8): the Access login identity is never committed to this public repo. */
  readonly OWNER_EMAIL?: string;
  /** Non-secret vars, empty in the repository; #21/#25 fill them per environment. */
  readonly ACCESS_TEAM_DOMAIN: string;
  readonly ACCESS_AUD: string;
  /** `'true'` on dev/stage for Playwright's service token, `'false'` in production. */
  readonly ALLOW_SERVICE_TOKEN: string;
  /** `local` only via the `--var` flag of `nx serve api` / the Dockerfile; #8 requires ENVIRONMENT=local as well. */
  readonly AUTH_MODE?: string;
  /** `true` makes the GitHub proxy (#9) answer from fixtures for local e2e. */
  readonly GITHUB_MOCK?: string;
  /** Secret: fine-grained PAT (decision 6). */
  readonly GITHUB_TOKEN?: string;
  /** Secret (#11). */
  readonly VAPID_PRIVATE_KEY?: string;
}
