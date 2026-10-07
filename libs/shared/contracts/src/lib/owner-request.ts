import type { SprintRefDto } from './sprint-commands';

/**
 * Owner requests to the PM (#219, ADR 0005): "move this issue to another sprint" or "up / down the queue". The
 * console posts one comment on the owner's token and never changes the sprint, a label or the order itself; the PM
 * reads the request at its next planning run and answers with a handled marker.
 */

export type SprintTarget = 'current' | 'next' | 'backlog';
export type QueueDirection = 'up' | 'down';

export const SPRINT_TARGETS: readonly SprintTarget[] = ['current', 'next', 'backlog'];
export const QUEUE_DIRECTIONS: readonly QueueDirection[] = ['up', 'down'];

/** One request per comment: a sprint move or a queue move, never both (ADR 0005 decision 1). */
export type OwnerRequest =
  | { readonly kind: 'sprint'; readonly target: SprintTarget }
  | { readonly kind: 'priority'; readonly direction: QueueDirection };

/** `pending` until a trusted handled marker names the request; then what the PM answered. */
export type OwnerRequestState = 'pending' | 'applied' | 'declined';

export const OWNER_REQUEST_STATES: readonly OwnerRequestState[] = ['pending', 'applied', 'declined'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Exactly `{kind, target}` or `{kind, direction}` with a known value, nothing else. */
export function isOwnerRequest(value: unknown): value is OwnerRequest {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value).sort().join(',');
  if (value['kind'] === 'sprint') {
    return keys === 'kind,target' && (SPRINT_TARGETS as readonly unknown[]).includes(value['target']);
  }
  if (value['kind'] === 'priority') {
    return keys === 'direction,kind' && (QUEUE_DIRECTIONS as readonly unknown[]).includes(value['direction']);
  }
  return false;
}

export function isOwnerRequestState(value: unknown): value is OwnerRequestState {
  return typeof value === 'string' && (OWNER_REQUEST_STATES as readonly string[]).includes(value);
}

/** `POST /api/v1/projects/:slug/issues/:number/request`. */
export interface OwnerRequestBody {
  readonly request: OwnerRequest;
  /** The milestone title the form showed (`null`: no milestone); another live one is 409 `issue-changed`. */
  readonly expectedMilestone: string | null;
  /** Optional words of the owner for the trailer, collapsed to one line. */
  readonly ownerSaid?: string;
}

export interface OwnerRequestResponse {
  readonly commentId: number;
  readonly url: string;
  /** ISO 8601: when GitHub created the comment. */
  readonly requestedAt: string;
  /** Answered from the 60 s replay window, nothing written again. */
  readonly replayed: boolean;
}

/** The newest request on an issue as the console recorded it (a cache of GitHub comments, never a decision). */
export type OwnerRequestStatusDto = OwnerRequest & {
  readonly state: OwnerRequestState;
  /** ISO 8601. */
  readonly requestedAt: string;
  /** The request comment on github.com. */
  readonly url: string;
  /** ISO 8601 of the PM's handled marker; `null` while pending. */
  readonly handledAt: string | null;
};

/** `GET /api/v1/projects/:slug/issues/:number/request`: what the form shows, read live. */
export interface IssueRequestDto {
  readonly number: number;
  readonly title: string;
  readonly state: 'open' | 'closed';
  /** The issue's milestone title now; `null` in the backlog. Sent back as `expectedMilestone`. */
  readonly milestone: string | null;
  /** The current sprint and the next one (`calendar.pick_current_sprint`); `null` when there is none. */
  readonly current: SprintRefDto | null;
  readonly next: SprintRefDto | null;
  /** Today is inside the current sprint's freeze. */
  readonly freezeNow: boolean;
  readonly request: OwnerRequestStatusDto | null;
}

/** One row of the issue picker. */
export interface RequestIssueDto {
  readonly number: number;
  readonly title: string;
  readonly request: OwnerRequestStatusDto | null;
}

/** `GET /api/v1/projects/:slug/requests`: the open issues the owner can ask about, newest first. */
export interface RequestIssuesDto {
  readonly items: readonly RequestIssueDto[];
}

/**
 * The problem `type` slugs of the request route: `issue-changed` (`milestone`: the live title to refill with),
 * `issue-closed`, `request-not-issue` (a pull request), `sprint-next-missing`, `sprint-none` (no current sprint),
 * `request-in-progress` (the same request is being written; `Retry-After`).
 */
export type OwnerRequestProblemType =
  | 'issue-changed'
  | 'issue-closed'
  | 'request-not-issue'
  | 'sprint-next-missing'
  | 'sprint-none'
  | 'request-in-progress';
