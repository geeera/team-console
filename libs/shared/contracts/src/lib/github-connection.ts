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

/** 403 `github-owner-not-connected`: the client offers Connect, and `connectUrl` says where it starts. */
export interface GitHubOwnerNotConnectedProblem extends ProblemDetails {
  readonly connectUrl: string;
}
