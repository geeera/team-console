import type { ProblemDetails } from './problem-details';

/** Where Settings starts the owner connection (#59, ADR 0003 decision 3); also the `connectUrl` of the 403. */
export const GITHUB_CONNECT_PATH = '/api/v1/github/connect';

/** The SPA route the OAuth callback returns to, with `?github=<GitHubConnectOutcome>`. */
export const GITHUB_SETTINGS_PATH = '/settings';

export type GitHubConnectionState = 'connected' | 'not-connected';

/** `GET /api/v1/github/connection`: the connection as Settings shows it. Never carries a token. */
export interface GitHubConnectionDto {
  readonly state: GitHubConnectionState;
  readonly login?: string;
  /** ISO 8601 UTC. */
  readonly connectedAt?: string;
  /**
   * The GitHub login the owner connection accepts (#89), only while `state` is `not-connected` — the approved
   * #24 wrong-account copy needs it before a first connect too, and it is config, not a secret.
   */
  readonly ownerLogin?: string;
}

/** `POST /api/v1/github/connect`: the GitHub authorize URL the client navigates to after checking its origin. */
export interface GitHubConnectStartDto {
  readonly authorizeUrl: string;
}

/**
 * The callback's result in the Settings URL: `connected`; `denied` (cancelled on GitHub); `wrong-account` (another
 * login authorized — its grant is already revoked; `login` names it); `failed` (anything else: expired or
 * tampered request, GitHub unavailable, app misconfigured).
 */
export type GitHubConnectOutcome = 'connected' | 'denied' | 'wrong-account' | 'failed';

/** Where the owner revokes the app by hand when the console could not (GitHub's authorized-apps settings). */
export const GITHUB_AUTHORIZED_APPS_URL = 'https://github.com/settings/applications';

/**
 * `DELETE /api/v1/github/connection` when the connection is gone from the console but the console could not confirm
 * the grant is revoked (200; a clean revoke is 204): `no-usable-token` — no stored token could be used (decrypt
 * failure, rotated key, refresh refused or expired); `token-rejected` — GitHub rejected the stored token, e.g.
 * because someone else refreshed the chain. The client tells the owner to revoke the app on GitHub (`manageUrl`).
 */
export interface GitHubDisconnectIncompleteDto {
  readonly revoked: false;
  readonly action: 'revoke-on-github';
  readonly reason: 'no-usable-token' | 'token-rejected';
  readonly manageUrl: string;
}

/** 403 `github-owner-not-connected`: the client offers Connect, and `connectUrl` says where it starts. */
export interface GitHubOwnerNotConnectedProblem extends ProblemDetails {
  readonly connectUrl: string;
}
