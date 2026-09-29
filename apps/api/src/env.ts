import type { WorkerBaseEnv } from '@worker/core';

/** Bindings of the `api` Worker. Vars are in wrangler.jsonc; secrets only in `wrangler secret`. */
export interface ApiEnv extends WorkerBaseEnv {
  readonly ASSETS: Fetcher;
  /** Secret (`wrangler secret put`, #7/#8): the Access login identity is never committed to this public repo. */
  readonly OWNER_EMAIL?: string;
  /** Non-secret vars, empty in the repository; #21/#25 fill them per environment. */
  readonly ACCESS_TEAM_DOMAIN: string;
  readonly ACCESS_AUD: string;
  /** `'true'` on dev/stage for Playwright's service token, `'false'` in production (ignored there anyway). */
  readonly ALLOW_SERVICE_TOKEN: string;
  /** The one service token client id (`common_name`) accepted on dev/stage; not a secret, empty in the repository. */
  readonly ACCESS_SERVICE_TOKEN_ID: string;
  /** `local` only via the `--var` flag of `nx serve api` / the Dockerfile; the bypass also needs ENVIRONMENT=local. */
  readonly AUTH_MODE?: string;
  /** `true` swaps api.github.com for the fixture GitHub of `@worker/github`; honoured only with ENVIRONMENT=local. */
  readonly GITHUB_MOCK?: string;
  /**
   * Non-secret vars of the console's GitHub App (ADR 0003 decision 7): empty in the repository, passed by
   * deploy.yml as `--var` from the GitHub Environment (`CONSOLE_GITHUB_APP_ID`, `CONSOLE_GITHUB_APP_CLIENT_ID`).
   */
  readonly GITHUB_APP_ID: string;
  readonly GITHUB_APP_CLIENT_ID: string;
  /** The only GitHub login the owner connection accepts (#59). */
  readonly OWNER_GITHUB_LOGIN: string;
  /** Secret: the app's key as PKCS#8 PEM; mints read-only installation tokens (#9). */
  readonly GITHUB_APP_PRIVATE_KEY?: string;
  /** Secret: OAuth client secret of the app, for the owner connection (#59). */
  readonly GITHUB_APP_CLIENT_SECRET?: string;
  /** Secret: 32 random bytes (base64); HKDF master key for the owner token pair at rest (#59). */
  readonly TOKEN_ENCRYPTION_KEY?: string;
  /** Secret (#11). */
  readonly VAPID_PRIVATE_KEY?: string;
}
