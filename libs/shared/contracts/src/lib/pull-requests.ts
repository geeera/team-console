import type { SprintCiState } from './read-models';
import type { ItemSummaryDto } from './tracker/dto';

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

/**
 * `GET …/prs/:number/items` (#627): the items `pr-linked` events link to the pull request, whatever the PR's own text
 * names, with their labels, so the merge gate reads the console's links. `repo` is the project's repository on
 * `provider` (#628): the gate checks that the pull request it judges is one of that repository's. One page in queue
 * order, closed items included; an empty page means no item is linked.
 */
export interface PullRequestItemsDto {
  readonly number: number;
  readonly provider: 'github' | 'gitlab';
  /** `owner/name` as the registry holds it; compare case-insensitively. */
  readonly repo: string;
  readonly items: readonly ItemSummaryDto[];
  /** The cursor for `?after=`, `null` on the last page. */
  readonly next: number | null;
}

export type PullRequestProblemType =
  | 'pull-request-not-found'
  | 'pull-request-number'
  // #612: `POST …/prs/:number/reviews`.
  | 'pull-request-not-open'
  | 'review-request-invalid'
  | 'review-request-role'
  | 'review-lineage';
