import { GITHUB_CONNECT_PATH } from '@shared/contracts';
import type { ProblemInit } from '@worker/core';

export type GitHubProblemType =
  | 'github-auth'
  | 'github-app-not-installed'
  | 'github-not-found'
  | 'github-owner-mismatch'
  | 'github-owner-not-connected'
  | 'github-rate-limit'
  | 'github-request-budget'
  | 'github-unavailable'
  | 'github-unexpected';

export interface GitHubProblem extends ProblemInit {
  readonly type: GitHubProblemType;
}

/**
 * A GitHub call that cannot be answered. Carries the Problem Details the Worker returns (ADR 0001 decision 19,
 * ADR 0003 decision 8) and GitHub's status for the log. The message is the problem title and never holds a
 * token, a URL or GitHub's body.
 */
export class GitHubError extends Error {
  constructor(
    readonly problem: GitHubProblem,
    /** GitHub's HTTP status, `null` when no response arrived (network failure, local misconfiguration). */
    readonly githubStatus: number | null,
  ) {
    super(problem.title);
    this.name = 'GitHubError';
  }
}

// When GitHub names no wait (a secondary limit without headers), its docs say to wait at least a minute.
const DEFAULT_RETRY_AFTER = 60;
const MAX_RETRY_AFTER = 3600;

export function githubAuthError(detail?: string, githubStatus: number | null = null): GitHubError {
  return new GitHubError(
    {
      type: 'github-auth',
      title: 'GitHub rejected the console app credentials',
      status: 503,
      ...(detail === undefined ? {} : { detail }),
    },
    githubStatus,
  );
}

export function githubUnexpectedError(detail: string, githubStatus: number | null = null): GitHubError {
  return new GitHubError(
    { type: 'github-unexpected', title: 'Unexpected answer from GitHub', status: 502, detail },
    githubStatus,
  );
}

export function githubUnavailableError(githubStatus: number | null): GitHubError {
  return new GitHubError(
    {
      type: 'github-unavailable',
      title: 'GitHub is unavailable',
      status: 502,
      detail: githubStatus === null ? 'GitHub could not be reached' : `GitHub answered ${githubStatus}`,
    },
    githubStatus,
  );
}

/**
 * The request's own subrequest budget is spent (#27): nothing was asked of GitHub. A GitHub problem so that a read
 * shared through the read cache fails the same way for every request that waits on it.
 */
export function requestBudgetError(): GitHubError {
  return new GitHubError(
    {
      type: 'github-request-budget',
      title: 'Not read in this request',
      status: 503,
      detail: "The request's GitHub subrequest budget is spent; the next request continues",
      retryAfter: 1,
    },
    null,
  );
}

export function appNotInstalledError(repo: string): GitHubError {
  return new GitHubError(
    {
      type: 'github-app-not-installed',
      title: 'The console app is not installed on this repository',
      status: 409,
      detail: `Install the team-console app on ${repo}`,
    },
    404,
  );
}

/**
 * 403 `github-owner-not-connected` (ADR 0003 decision 4): no usable owner connection in this environment. The
 * extension member `connectUrl` tells the client where Connect starts; the client branches on `type`.
 */
export function ownerNotConnectedError(): GitHubError {
  return new GitHubError(
    {
      type: 'github-owner-not-connected',
      title: 'Connect GitHub to write as the owner',
      status: 403,
      extensions: { connectUrl: GITHUB_CONNECT_PATH },
    },
    null,
  );
}

/**
 * 409 `github-owner-mismatch` (ADR 0003 decision 2(b)): the repository's owner is not the connected account, so
 * an answer written there would not count as the owner's. `repoOwner` is GitHub's `owner.login` of the repo.
 */
export function ownerMismatchError(repo: string, repoOwner: string): GitHubError {
  return new GitHubError(
    {
      type: 'github-owner-mismatch',
      title: 'The repository owner is not the connected GitHub account',
      status: 409,
      detail: `${repo} belongs to ${repoOwner}`,
    },
    null,
  );
}

function isRateLimited(response: Response): boolean {
  if (response.status === 429) {
    return true;
  }
  return (
    response.status === 403 &&
    (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after'))
  );
}

/** Seconds to wait: `Retry-After` when GitHub sends it, else until `x-ratelimit-reset`, else a minute. */
export function retryAfterOf(headers: Headers, nowMs: number): number {
  const retryAfter = Number(headers.get('retry-after'));
  if (headers.has('retry-after') && Number.isFinite(retryAfter) && retryAfter >= 0) {
    return Math.min(Math.ceil(retryAfter), MAX_RETRY_AFTER);
  }
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (headers.has('x-ratelimit-reset') && Number.isFinite(reset) && reset > 0) {
    return Math.min(Math.max(Math.ceil(reset - nowMs / 1000), 1), MAX_RETRY_AFTER);
  }
  return DEFAULT_RETRY_AFTER;
}

/**
 * Maps a non-2xx GitHub response (the #9 table): 401/403 without rate-limit headers → 503 `github-auth` (the
 * app credential is broken); rate limit → 429 with `Retry-After`; 404 → 404; 5xx → 502 `github-unavailable`;
 * anything else → 502 `github-unexpected`. GitHub's body is never read into the problem.
 */
export function mapGitHubResponse(response: Response, nowMs: number = Date.now()): GitHubError {
  const status = response.status;
  if (isRateLimited(response)) {
    return new GitHubError(
      {
        type: 'github-rate-limit',
        title: 'GitHub rate limit reached',
        status: 429,
        retryAfter: retryAfterOf(response.headers, nowMs),
      },
      status,
    );
  }
  if (status === 401 || status === 403) {
    return githubAuthError(undefined, status);
  }
  if (status === 404) {
    return new GitHubError({ type: 'github-not-found', title: 'Not found on GitHub', status: 404 }, status);
  }
  if (status >= 500) {
    return githubUnavailableError(status);
  }
  return githubUnexpectedError(`GitHub answered ${status}`, status);
}
