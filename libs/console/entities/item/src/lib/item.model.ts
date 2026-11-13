import {
  isActorKind,
  isAskCategory,
  isAskCommand,
  isClosedReason,
  isCommentKind,
  isDecisionCommand,
  isItemEventKind,
  isItemKind,
  isItemSeverity,
  isItemStatus,
  isItemTier,
  isSprintState,
  MAX_FREEZE_DAYS,
  type ActorDto,
  type AskDto,
  type AskListDto,
  type CommentDto,
  type CommentListDto,
  type DecisionDto,
  type DecisionListDto,
  type ItemDto,
  type ItemEventDto,
  type ItemEventListDto,
  type ItemListDto,
  type ItemSummaryDto,
  type SprintFreezeDaysDto,
  type TrackerSprintDto,
  type TrackerSprintListDto,
} from '@shared/contracts';

/**
 * The console tracker's read models as the console reads them (#435, ADR 0006). The Worker is the same origin, but
 * nothing is taken on trust: every body is checked here before a screen sees it, and every text field is rendered by
 * interpolation only.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || isPositiveInteger(value);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isListOf<T>(value: unknown, is: (entry: unknown) => entry is T): value is T[] {
  return Array.isArray(value) && value.every(is);
}

function isActor(value: unknown): value is ActorDto {
  return isRecord(value) && isActorKind(value['kind']) && typeof value['name'] === 'string';
}

export function isItemSummaryDto(value: unknown): value is ItemSummaryDto {
  return (
    isRecord(value) &&
    typeof value['key'] === 'string' &&
    isPositiveInteger(value['number']) &&
    isItemKind(value['kind']) &&
    isItemStatus(value['status']) &&
    (value['severity'] === null || isItemSeverity(value['severity'])) &&
    (value['tier'] === null || isItemTier(value['tier'])) &&
    isNullableNumber(value['sprint']) &&
    typeof value['title'] === 'string' &&
    isStringList(value['labels']) &&
    isStringList(value['flags']) &&
    (value['state'] === 'open' || value['state'] === 'closed') &&
    isNullableString(value['closedAt']) &&
    (value['closedReason'] === null || isClosedReason(value['closedReason'])) &&
    isActor(value['createdBy']) &&
    typeof value['createdAt'] === 'string' &&
    typeof value['updatedAt'] === 'string' &&
    isPositiveInteger(value['version']) &&
    (value['source'] === 'console' || value['source'] === 'import') &&
    isNullableString(value['sourceUrl'])
  );
}

export function isItemDto(value: unknown): value is ItemDto {
  return isItemSummaryDto(value) && typeof (value as unknown as Record<string, unknown>)['body'] === 'string';
}

export function isItemListDto(value: unknown): value is ItemListDto {
  return isRecord(value) && isListOf(value['items'], isItemSummaryDto) && isNullableNumber(value['next']);
}

function isItemEvent(value: unknown): value is ItemEventDto {
  return (
    isRecord(value) &&
    isPositiveInteger(value['id']) &&
    typeof value['at'] === 'string' &&
    isActor(value['actor']) &&
    isItemEventKind(value['kind'])
  );
}

export function isItemEventListDto(value: unknown): value is ItemEventListDto {
  return isRecord(value) && isListOf(value['events'], isItemEvent) && isNullableNumber(value['next']);
}

function isComment(value: unknown): value is CommentDto {
  return (
    isRecord(value) &&
    isPositiveInteger(value['id']) &&
    isCommentKind(value['kind']) &&
    isActor(value['author']) &&
    typeof value['body'] === 'string' &&
    typeof value['createdAt'] === 'string' &&
    (value['source'] === 'console' || value['source'] === 'import') &&
    isNullableString(value['sourceUrl'])
  );
}

export function isCommentDto(value: unknown): value is CommentDto {
  return isComment(value);
}

export function isCommentListDto(value: unknown): value is CommentListDto {
  return isRecord(value) && isListOf(value['comments'], isComment) && isNullableNumber(value['next']);
}

function isSprint(value: unknown): value is TrackerSprintDto {
  return (
    isRecord(value) &&
    isPositiveInteger(value['number']) &&
    typeof value['title'] === 'string' &&
    isNullableString(value['dueOn']) &&
    isSprintState(value['state']) &&
    typeof value['description'] === 'string' &&
    typeof value['createdAt'] === 'string' &&
    isNullableString(value['closedAt'])
  );
}

export function isTrackerSprintDto(value: unknown): value is TrackerSprintDto {
  return isSprint(value);
}

export function isTrackerSprintListDto(value: unknown): value is TrackerSprintListDto {
  return isRecord(value) && isListOf(value['sprints'], isSprint);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** The sprint list with the open counts the board's headers show (#561): a body without them is unexpected. */
export function isTrackerSprintCountsDto(value: unknown): value is TrackerSprintListDto {
  return (
    isTrackerSprintListDto(value) &&
    isCount(value.backlogOpenCount) &&
    value.sprints.every((sprint) => isCount(sprint.openCount))
  );
}

function isAsk(value: unknown): value is AskDto {
  return (
    isRecord(value) &&
    isPositiveInteger(value['id']) &&
    isAskCategory(value['category']) &&
    typeof value['ask'] === 'string' &&
    isListOf(value['commands'], isAskCommand) &&
    (value['recommended'] === null || isAskCommand(value['recommended'])) &&
    (value['source'] === 'console' || value['source'] === 'import') &&
    (value['state'] === 'open' || value['state'] === 'answered' || value['state'] === 'withdrawn')
  );
}

export function isAskListDto(value: unknown): value is AskListDto {
  return isRecord(value) && isListOf(value['asks'], isAsk) && isNullableNumber(value['next']);
}

function isDecision(value: unknown): value is DecisionDto {
  return (
    isRecord(value) &&
    isPositiveInteger(value['id']) &&
    isDecisionCommand(value['command']) &&
    typeof value['text'] === 'string' &&
    isNullableNumber(value['askId']) &&
    typeof value['decidedAt'] === 'string'
  );
}

export function isDecisionDto(value: unknown): value is DecisionDto {
  return isDecision(value);
}

/** `GET …/sprint-freeze` (#457): a whole number of days within the bound the Worker reads project.yml with. */
export function isSprintFreezeDaysDto(value: unknown): value is SprintFreezeDaysDto {
  const days = isRecord(value) ? value['freezeDays'] : undefined;
  return typeof days === 'number' && Number.isInteger(days) && days >= 0 && days <= MAX_FREEZE_DAYS;
}

export function isDecisionListDto(value: unknown): value is DecisionListDto {
  return isRecord(value) && isListOf(value['decisions'], isDecision) && isNullableNumber(value['next']);
}

const ITEM_NUMBER = /^[1-9][0-9]{0,8}$/;

/** The item number of a `/p/:slug/t/:n` segment: a bare number only, so a route never carries a key or a path. */
export function itemNumberOfSegment(segment: string | null | undefined): number | null {
  return segment !== null && segment !== undefined && ITEM_NUMBER.test(segment) ? Number(segment) : null;
}

/** The console route of an item, as the board, Find and Needs you link it. */
export function itemRouteOf(slug: string, number: number): string[] {
  return ['/p', slug, 't', String(number)];
}

/** Whether an item is closed as not needed (`not-planned` or `duplicate`), which Reopen undoes. */
export function isClosedAsNotNeeded(item: ItemSummaryDto): boolean {
  return item.state === 'closed' && item.closedReason !== 'done';
}

/** The status a screen shows: `closed` for an item closed as not needed, else its status. */
export type ShownStatus = ItemSummaryDto['status'] | 'closed';

export function shownStatusOf(item: ItemSummaryDto): ShownStatus {
  return isClosedAsNotNeeded(item) ? 'closed' : item.status;
}

/** `https://github.com/…` only: an imported item's old issue, never any other link. */
export function githubSourceUrlOf(item: ItemSummaryDto): string | null {
  const url = item.sourceUrl;
  if (item.source !== 'import' || url === null) {
    return null;
  }
  try {
    const parsed = new URL(url);
    return parsed.origin === 'https://github.com' && parsed.username === '' ? parsed.href : null;
  } catch {
    // Not a URL at all: no link rather than a broken one.
    return null;
  }
}

/** The old GitHub number of an imported item: numbers are kept (ADR 0006), so it is the item's own. */
export function githubNumberOf(item: ItemSummaryDto): number | null {
  return githubSourceUrlOf(item) === null ? null : item.number;
}
