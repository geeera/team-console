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
] as const;
export type ItemEventKind = (typeof ITEM_EVENT_KINDS)[number];

export const SPRINT_STATES = ['open', 'closed'] as const;
export type SprintState = (typeof SPRINT_STATES)[number];

/** Label prefixes that are columns (ADR decision 3): never an `item_labels` row, never a custom label. */
export const COLUMN_LABEL_PREFIXES = ['status:', 'kind:', 'tier:', 'sev:'] as const;

export const ITEM_TITLE_MAX_LENGTH = 256;
export const ITEM_BODY_MAX_LENGTH = 65_536;
export const COMMENT_BODY_MAX_LENGTH = 65_536;
export const SPRINT_DESCRIPTION_MAX_LENGTH = 65_536;
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
