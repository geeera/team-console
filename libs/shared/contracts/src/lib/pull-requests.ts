import type { SprintCiState } from './read-models';

/** `GET /api/v1/projects/:slug/prs` (#463): pull requests as the console mirrors them in `pull_requests`. */

export type PullRequestStateDto = 'open' | 'closed' | 'merged';

export interface PullRequestDto {
  readonly number: number;
  /** Plain text, invisible characters removed; render by interpolation only. */
  readonly title: string;
  readonly state: PullRequestStateDto;
  readonly draft: boolean;
  readonly headRef: string;
  readonly headSha: string;
  readonly baseRef: string;
  readonly author: string | null;
  /** The pull request's page on the provider, built by the Worker from the repository and number. */
  readonly url: string;
  /** CI of `headSha` as last read; `unknown` until read for this head. */
  readonly ci: SprintCiState;
  /** A run on the head finished, or it moved, since `ci` was read: `?fresh=1` reads it again. */
  readonly ciStale: boolean;
  /** The provider's last change, ISO 8601 UTC. */
  readonly updatedAt: string;
  /** When the console last wrote the row, ISO 8601 UTC. */
  readonly syncedAt: string;
}

/** What a `?fresh=1` read of the provider did; `complete: false` when the request's budget or the provider stopped it. */
export interface PullRequestSyncDto {
  readonly complete: boolean;
}

export interface PullRequestListDto {
  readonly pullRequests: readonly PullRequestDto[];
  /** The cursor for `?after=`, `null` on the last page. */
  readonly next: number | null;
  /** `null` without `?fresh=1`. */
  readonly sync: PullRequestSyncDto | null;
}

export type PullRequestProblemType = 'pull-request-not-found' | 'pull-request-number';
