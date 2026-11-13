import type { AnswerCommand } from '../answer';
import type { OwnerCategory } from '../batch-answer';

/**
 * The console's own tracker (#410, ADR 0006 "Data model"): the enumerations and bounds migration 0013 enforces with
 * CHECK constraints, shared by the Worker's validation and, from Phase 1b, the console's forms. The lists follow the
 * plugin's `ptlib/labels.py` (`STATUSES`, `KINDS`, `SEVERITIES`, the `tier:*` labels).
 */

/** `projects.tracker`: `github` refuses every tracker write (409 `tracker-not-cut-over`). */
export const TRACKER_MODES = ['github', 'cutover', 'console'] as const;
export type TrackerMode = (typeof TRACKER_MODES)[number];

export const ITEM_KINDS = ['feature', 'bug', 'chore', 'finding', 'wow', 'question'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export const ITEM_STATUSES = ['proposed', 'approved', 'in-progress', 'qa', 'done', 'blocked'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];
/**
 * Statuses that say the item is being worked on, so they need the owner's scope approval (#452). Excluded are
 * `proposed` (waiting for it) and `done` (closed; the release decision closes items it never approved).
 */
export const WORKABLE_STATUSES = [
  'approved',
  'in-progress',
  'qa',
  'blocked',
] as const satisfies readonly ItemStatus[];
export const isWorkableStatus = (status: ItemStatus): boolean =>
  (WORKABLE_STATUSES as readonly ItemStatus[]).includes(status);

export const ITEM_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type ItemSeverity = (typeof ITEM_SEVERITIES)[number];

export const ITEM_TIERS = ['light', 'standard', 'heavy'] as const;
export type ItemTier = (typeof ITEM_TIERS)[number];

export const CLOSED_REASONS = ['done', 'not-planned', 'duplicate'] as const;
export type ClosedReason = (typeof CLOSED_REASONS)[number];

export const ITEM_SOURCES = ['console', 'import'] as const;
export type ItemSource = (typeof ITEM_SOURCES)[number];

/** Who wrote a row; display and audit only, the server derives it from the identity, never from a body. */
export const ACTOR_KINDS = ['owner', 'job', 'runner', 'system', 'import'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export const COMMENT_KINDS = ['comment', 'decision', 'note'] as const;
export type CommentKind = (typeof COMMENT_KINDS)[number];

export const ITEM_EVENT_KINDS = [
  'created',
  'edited',
  'status',
  'labels',
  'sprint',
  'closed',
  'reopened',
  'commented',
  'decided',
  'asked',
  'answered',
  'requested',
  'handled',
  'pr-linked',
  'imported',
  // #462: the owner masked the title and body in the item's created/edited events (`…/events/scrub`).
  'scrubbed',
  // #456: the item took another place in its queue (`…/items/:key/queue`); before/after = {rank}.
  'reordered',
] as const;
export type ItemEventKind = (typeof ITEM_EVENT_KINDS)[number];

/** `POST …/items/:key/queue` (#456, #409 §2.2): First in the queue, Up, Down — within the item's lane. */
export const QUEUE_MOVES = ['first', 'up', 'down'] as const;
export type QueueMove = (typeof QUEUE_MOVES)[number];
export function isQueueMove(value: unknown): value is QueueMove {
  return typeof value === 'string' && (QUEUE_MOVES as readonly string[]).includes(value);
}

export const SPRINT_STATES = ['open', 'closed'] as const;
export type SprintState = (typeof SPRINT_STATES)[number];

/**
 * Asks, owner decisions and owner requests (#434, ADR 0006 Phase 1a′, migration 0014). `ASK_CATEGORIES` is the
 * plugin's `owner.CATEGORIES` (`OWNER_CATEGORIES` of `@shared/owner-grammar`, which also pins it against the plugin).
 */
export const ASK_CATEGORIES = [
  'money',
  'scope',
  'release',
  'access',
  'legal',
  'design',
] as const satisfies readonly OwnerCategory[];
export type AskCategory = OwnerCategory;

/**
 * What an `owner_decisions` row records: the plugin's `ANSWERABLE` plus `resume` (Phase 4's `team_state`; refused by
 * the route until then, admitted by the CHECK so it never changes).
 */
export const DECISION_COMMANDS = [
  'approve',
  'reject',
  'go',
  'no-go',
  'done',
  'override',
  'resume',
] as const satisfies readonly (AnswerCommand | 'resume')[];
export type DecisionCommand = (typeof DECISION_COMMANDS)[number];

/** The commands an ask may offer: what an answer can carry (`ANSWERABLE`), so not `resume`. */
export type AskCommand = AnswerCommand;

/** How a decision reached the console; `import` is written by the import writer only, never through a route. */
export const DECISION_VIA = ['web', 'push', 'import'] as const;
export type DecisionVia = (typeof DECISION_VIA)[number];

export const REQUEST_KINDS = ['sprint', 'priority'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

export const REQUEST_RESULTS = ['applied', 'declined'] as const;
export type RequestResult = (typeof REQUEST_RESULTS)[number];

/** `GET …/projects/:slug/requests?state=` (#445): the newest request per item, by whether the PM answered it. */
export const REQUEST_STATES = ['pending', 'handled', 'all'] as const;
export type RequestState = (typeof REQUEST_STATES)[number];

export const ASK_TEXT_MAX_LENGTH = 2048;
/** A decision's `text`, as for an answer on GitHub (`ANSWER_TEXT_MAX_LENGTH`). */
export const DECISION_TEXT_MAX_LENGTH = 2000;
export const REQUEST_REASON_MAX_LENGTH = 1024;
/** A linked pull request's page (#445); GitHub's own URLs are far shorter. */
export const PR_URL_MAX_LENGTH = 512;
/** Git's own bound on a ref name, as `isBranchName` judges it on the worker side. */
export const PR_HEAD_REF_MAX_LENGTH = 255;
/** At most every answer command once. */
export const ASK_COMMANDS_MAX = 6;

/** Label prefixes that are columns (ADR decision 3): never an `item_labels` row, never a custom label. */
export const COLUMN_LABEL_PREFIXES = ['status:', 'kind:', 'tier:', 'sev:'] as const;

export const ITEM_TITLE_MAX_LENGTH = 256;
export const ITEM_BODY_MAX_LENGTH = 65_536;
export const COMMENT_BODY_MAX_LENGTH = 65_536;
export const SPRINT_DESCRIPTION_MAX_LENGTH = 65_536;
/** A sprint's name, one line of plain text; the `sprints.title` column's own bound (#538). */
export const SPRINT_TITLE_MAX_LENGTH = 256;
export const LABEL_DESCRIPTION_MAX_LENGTH = 100;
/** Label names as the plugin writes them (`status:qa`, `agent:dev`, `needs-design`). */
export const LABEL_NAME_PATTERN = /^[a-z][a-z0-9:-]{0,49}$/;
export const LABEL_COLOR_PATTERN = /^[0-9a-f]{6}$/;
/** `projects.key_prefix`: items read `TC-310`. */
export const KEY_PREFIX_PATTERN = /^[A-Z]{2,5}$/;

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

export const isTrackerMode = (value: unknown): value is TrackerMode => isOneOf(TRACKER_MODES, value);
export const isItemKind = (value: unknown): value is ItemKind => isOneOf(ITEM_KINDS, value);
export const isItemStatus = (value: unknown): value is ItemStatus => isOneOf(ITEM_STATUSES, value);
export const isItemSeverity = (value: unknown): value is ItemSeverity => isOneOf(ITEM_SEVERITIES, value);
export const isItemTier = (value: unknown): value is ItemTier => isOneOf(ITEM_TIERS, value);
export const isClosedReason = (value: unknown): value is ClosedReason => isOneOf(CLOSED_REASONS, value);
export const isActorKind = (value: unknown): value is ActorKind => isOneOf(ACTOR_KINDS, value);
export const isCommentKind = (value: unknown): value is CommentKind => isOneOf(COMMENT_KINDS, value);
export const isItemEventKind = (value: unknown): value is ItemEventKind => isOneOf(ITEM_EVENT_KINDS, value);
export const isSprintState = (value: unknown): value is SprintState => isOneOf(SPRINT_STATES, value);
export const isDecisionCommand = (value: unknown): value is DecisionCommand =>
  isOneOf(DECISION_COMMANDS, value);
export const isAskCommand = (value: unknown): value is AskCommand =>
  isDecisionCommand(value) && value !== 'resume';
export const isAskCategory = (value: unknown): value is AskCategory => isOneOf(ASK_CATEGORIES, value);
export const isDecisionVia = (value: unknown): value is DecisionVia => isOneOf(DECISION_VIA, value);
export const isRequestKind = (value: unknown): value is RequestKind => isOneOf(REQUEST_KINDS, value);
export const isRequestResult = (value: unknown): value is RequestResult => isOneOf(REQUEST_RESULTS, value);
export const isRequestState = (value: unknown): value is RequestState => isOneOf(REQUEST_STATES, value);

/** Whether `name` is a well-formed flag: a label name outside the column-backed prefixes. */
export function isFlagName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    LABEL_NAME_PATTERN.test(name) &&
    !COLUMN_LABEL_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/** `TC-310` for prefix `TC` and number 310. */
export function itemKeyOf(keyPrefix: string, number: number): string {
  return `${keyPrefix}-${String(number)}`;
}

const ITEM_KEY = /^([A-Z]{2,5})-([1-9][0-9]{0,8})$/;
const ITEM_NUMBER = /^[1-9][0-9]{0,8}$/;

/**
 * The item number a path segment names in a project with `keyPrefix`: its key (`TC-310`) or the bare number (`310`).
 * `'other-project'` for a well-formed key with another prefix, `null` for anything else.
 */
export function itemNumberOfKey(segment: string, keyPrefix: string): number | 'other-project' | null {
  if (ITEM_NUMBER.test(segment)) {
    return Number(segment);
  }
  const match = ITEM_KEY.exec(segment);
  if (match === null) {
    return null;
  }
  return match[1] === keyPrefix ? Number(match[2]) : 'other-project';
}
