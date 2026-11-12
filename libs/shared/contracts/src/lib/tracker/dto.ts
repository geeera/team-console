import type { OwnerRequest } from '../owner-request';
import type {
  ActorKind,
  AskCategory,
  AskCommand,
  DecisionCommand,
  DecisionVia,
  RequestResult,
  ClosedReason,
  CommentKind,
  ItemEventKind,
  ItemKind,
  ItemSeverity,
  ItemSource,
  ItemStatus,
  ItemTier,
  SprintState,
} from './vocabulary';

/**
 * The console's own tracker over the API (#410, ADR 0006): items, sprints, comments, events and labels as D1 holds
 * them. Separate from the GitHub-backed board DTOs (`SprintDto`, `SprintIssueDto`), which the board keeps reading
 * until Phase 1b. Every text field is plain text as its author typed it; render it by interpolation only.
 */

/** Who wrote a row. `name` is display only (`owner`, a role, an imported login) and never authorises anything. */
export interface ActorDto {
  readonly kind: ActorKind;
  readonly name: string;
}

/** An item in a list: everything but the body. */
export interface ItemSummaryDto {
  /** `TC-310`: the project's key prefix and the number. */
  readonly key: string;
  readonly number: number;
  readonly kind: ItemKind;
  readonly status: ItemStatus;
  readonly severity: ItemSeverity | null;
  readonly tier: ItemTier | null;
  /** The sprint's number in the project, `null` outside a sprint. */
  readonly sprint: number | null;
  readonly title: string;
  /**
   * The full label set as the plugin reads it (`status:qa`, `kind:bug`, `tier:heavy`, `sev:high`, then the flags in
   * name order), so `picker.py`, `tiers.py` and `inbox.py` classify unchanged (ADR 0006 decision 3).
   */
  readonly labels: readonly string[];
  /** The flags alone, in name order. */
  readonly flags: readonly string[];
  readonly state: 'open' | 'closed';
  readonly closedAt: string | null;
  readonly closedReason: ClosedReason | null;
  readonly createdBy: ActorDto;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Send it back as `If-Match: "<version>"` to change the item; the `ETag` of an item response. */
  readonly version: number;
  readonly source: ItemSource;
  readonly sourceUrl: string | null;
}

export interface ItemDto extends ItemSummaryDto {
  readonly body: string;
}

/** `GET …/items`: one page in number order; `next` is the `after` cursor of the next page. */
export interface ItemListDto {
  readonly items: readonly ItemSummaryDto[];
  readonly next: number | null;
}

export interface TrackerSprintDto {
  readonly number: number;
  /** `Sprint NN`. */
  readonly title: string;
  /** YYYY-MM-DD, the demo day; `null` when none was set. */
  readonly dueOn: string | null;
  readonly state: SprintState;
  readonly description: string;
  readonly createdAt: string;
  readonly closedAt: string | null;
}

export interface TrackerSprintListDto {
  readonly sprints: readonly TrackerSprintDto[];
}

export interface CommentDto {
  readonly id: number;
  readonly kind: CommentKind;
  readonly author: ActorDto;
  readonly body: string;
  readonly createdAt: string;
  readonly source: ItemSource;
  readonly sourceUrl: string | null;
}

export interface CommentListDto {
  readonly comments: readonly CommentDto[];
  /** The `after` cursor (a comment id) of the next page. */
  readonly next: number | null;
}

/** One audited change; `before`/`after` hold the changed fields only. */
export interface ItemEventDto {
  readonly id: number;
  readonly at: string;
  readonly actor: ActorDto;
  readonly kind: ItemEventKind;
  readonly before: unknown;
  readonly after: unknown;
}

export interface ItemEventListDto {
  readonly events: readonly ItemEventDto[];
  readonly next: number | null;
}

export interface LabelDto {
  readonly name: string;
  /** Six lower-case hex digits, no `#`. */
  readonly color: string;
  readonly description: string;
  /** One of the plugin's labels (`ptlib/labels.py`); the rest are the owner's. */
  readonly builtin: boolean;
}

export interface LabelListDto {
  readonly labels: readonly LabelDto[];
}

/**
 * A question to the owner (#434, `asks`). `ask` is the asking job's plain text; render it by interpolation only.
 * `source: 'import'` is a GitHub-era ask that is re-confirmed on the cutover screen, never answered as is.
 */
export interface AskDto {
  readonly id: number;
  readonly category: AskCategory;
  readonly ask: string;
  readonly commands: readonly AskCommand[];
  readonly recommended: AskCommand | null;
  readonly createdAt: string;
  readonly source: ItemSource;
  /** `open` until a decision answers it or a newer ask replaces it. */
  readonly state: 'open' | 'answered' | 'withdrawn';
  readonly answeredByDecisionId: number | null;
  readonly withdrawnAt: string | null;
}

export interface AskListDto {
  readonly asks: readonly AskDto[];
  /** The `after` cursor (an ask id) of the next page. */
  readonly next: number | null;
}

/** An owner decision (`owner_decisions`), append-only. `via: 'import'` rows are history and drove nothing. */
export interface DecisionDto {
  readonly id: number;
  readonly command: DecisionCommand;
  readonly text: string;
  readonly askId: number | null;
  readonly reversesCommentId: number | null;
  readonly via: DecisionVia;
  readonly decidedAt: string;
  readonly sourceUrl: string | null;
}

export interface DecisionListDto {
  readonly decisions: readonly DecisionDto[];
  readonly next: number | null;
}

/** An owner request to the PM on an item (`item_requests`). The newest per item is the one the PM still owes. */
export interface ItemRequestDto {
  readonly id: number;
  /** `null` when the stored payload is not a request this version knows (it is then never acted on). */
  readonly request: OwnerRequest | null;
  readonly requestedAt: string;
  /** `null` while the PM has not answered. */
  readonly result: RequestResult | null;
  readonly reason: string | null;
  readonly handledAt: string | null;
}

export interface ItemRequestListDto {
  readonly requests: readonly ItemRequestDto[];
  readonly next: number | null;
}

/** The item a project-wide row belongs to (#445): enough to address it and show it without another read. */
export interface ItemRefDto {
  readonly key: string;
  readonly number: number;
}

/** `GET …/projects/:slug/decisions` (#445): every decision of the project, oldest first, with its item. */
export interface ProjectDecisionDto extends DecisionDto {
  readonly item: ItemRefDto;
}

export interface ProjectDecisionListDto {
  readonly decisions: readonly ProjectDecisionDto[];
  /** The `after` cursor (a decision id) of the next page. */
  readonly next: number | null;
}

/**
 * `GET …/projects/:slug/requests?state=` (#445): the newest request of each item, oldest first. `item.title` is the
 * item's plain text (render by interpolation); `item.state` lets the PM skip a request on an item closed since.
 */
export interface ProjectRequestDto extends ItemRequestDto {
  readonly item: ItemRefDto & { readonly title: string; readonly state: 'open' | 'closed' };
}

export interface ProjectRequestListDto {
  readonly requests: readonly ProjectRequestDto[];
  /** The `after` cursor (a request id) of the next page. */
  readonly next: number | null;
}

/**
 * A pull request linked to an item (#445, the item's `pr-linked` event). `url` is the one the server built from the
 * project's repository and `number`, never the client's string.
 */
export interface PrLinkDto {
  readonly number: number;
  readonly url: string;
  readonly headRef: string;
  readonly linkedAt: string;
  readonly linkedBy: ActorDto;
}

/** Problem types of the tracker routes, beyond `owner-only`, `csrf` and `project-not-found`. */
export type TrackerProblemType =
  | 'tracker-not-cut-over'
  | 'item-not-found'
  | 'item-key'
  | 'item-invalid'
  | 'item-version'
  | 'item-version-required'
  | 'sprint-not-found'
  | 'sprint-exists'
  | 'sprint-invalid'
  | 'comment-not-found'
  | 'comment-invalid'
  | 'label-not-found'
  | 'label-invalid'
  | 'label-exists'
  | 'query-invalid'
  | 'idempotency-key'
  | 'idempotency-key-reused'
  | 'idempotency-in-flight'
  | 'transition-owner-only'
  | 'transition-role'
  // #434: asks, decisions, requests.
  | 'ask-invalid'
  | 'ask-not-found'
  | 'ask-role'
  | 'ask-not-open'
  | 'ask-imported'
  | 'decision-invalid'
  | 'decision-command'
  | 'decision-not-found'
  | 'request-invalid'
  | 'request-not-found'
  | 'request-handled'
  | 'request-handled-role'
  | 'item-closed'
  | 'item-changed'
  // #444: the route matrix and the comment kinds.
  | 'sprint-role'
  | 'comment-kind'
  // #462: a job's text carries a secret shape (`@shared/redaction`).
  | 'body-secret'
  // #445: pull request links.
  | 'pr-link-invalid'
  | 'pr-link-role'
  | 'pr-link-conflict'
  | 'pr-link-provider';
