import {
  itemKeyOf,
  type AskDto,
  type DecisionDto,
  type ItemRequestDto,
  type CommentDto,
  type ItemDto,
  type ItemEventDto,
  type ItemSummaryDto,
  type LabelDto,
  type TrackerSprintDto,
} from '@shared/contracts';
import { withoutInvisibles } from '@shared/plain-text';
import type {
  AskRecord,
  DecisionRecord,
  ItemRequestRecord,
  CommentRecord,
  ItemEventRecord,
  ItemRecord,
  ItemSummaryRecord,
  LabelRecord,
  SprintRecord,
} from '@worker/db';

/*
 * Titles are cleaned on the way in (`checkCreateItemInput`) and again on the way out (#287): an imported row (Phase
 * 1b) reaches the DTO without passing the input checks.
 */

/** The full label set the plugin's label logic reads: the column labels first, then the flags (ADR 0006 decision 3). */
export function labelsOf(item: ItemSummaryRecord): string[] {
  return [
    `status:${item.status}`,
    `kind:${item.kind}`,
    ...(item.tier === null ? [] : [`tier:${item.tier}`]),
    ...(item.severity === null ? [] : [`sev:${item.severity}`]),
    ...item.flags,
  ];
}

export function itemSummaryDtoOf(keyPrefix: string, item: ItemSummaryRecord): ItemSummaryDto {
  return {
    key: itemKeyOf(keyPrefix, item.number),
    number: item.number,
    kind: item.kind,
    status: item.status,
    severity: item.severity,
    tier: item.tier,
    sprint: item.sprintNumber,
    title: withoutInvisibles(item.title),
    labels: labelsOf(item),
    flags: item.flags,
    state: item.closedAt === null ? 'open' : 'closed',
    closedAt: item.closedAt,
    closedReason: item.closedReason,
    createdBy: { kind: item.createdByKind, name: item.createdBy },
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    version: item.version,
    source: item.source,
    sourceUrl: item.sourceUrl,
  };
}

export function itemDtoOf(keyPrefix: string, item: ItemRecord): ItemDto {
  return { ...itemSummaryDtoOf(keyPrefix, item), body: item.body };
}

export function sprintDtoOf(sprint: SprintRecord, openCount: number): TrackerSprintDto {
  return {
    number: sprint.number,
    title: withoutInvisibles(sprint.title),
    dueOn: sprint.dueOn,
    state: sprint.state,
    description: sprint.description,
    createdAt: sprint.createdAt,
    closedAt: sprint.closedAt,
    openCount,
  };
}

export function commentDtoOf(comment: CommentRecord): CommentDto {
  return {
    id: comment.id,
    kind: comment.kind,
    author: { kind: comment.authorKind, name: comment.author },
    body: comment.body,
    createdAt: comment.createdAt,
    source: comment.source,
    sourceUrl: comment.sourceUrl,
  };
}

export function itemEventDtoOf(event: ItemEventRecord): ItemEventDto {
  return {
    id: event.id,
    at: event.at,
    actor: { kind: event.actorKind, name: event.actor },
    kind: event.kind,
    before: event.before,
    after: event.after,
  };
}

export function labelDtoOf(label: LabelRecord): LabelDto {
  return { name: label.name, color: label.color, description: label.description, builtin: label.builtin };
}

export function askDtoOf(ask: AskRecord): AskDto {
  return {
    id: ask.id,
    category: ask.category,
    // A job writes the ask, possibly steered by item text: no bidi override or zero-width run may reshape it (#443).
    ask: withoutInvisibles(ask.ask),
    commands: ask.commands,
    recommended: ask.recommended,
    createdAt: ask.createdAt,
    source: ask.source,
    state: ask.answeredByDecisionId !== null ? 'answered' : ask.withdrawnAt !== null ? 'withdrawn' : 'open',
    answeredByDecisionId: ask.answeredByDecisionId,
    withdrawnAt: ask.withdrawnAt,
  };
}

export function decisionDtoOf(decision: DecisionRecord): DecisionDto {
  return {
    id: decision.id,
    command: decision.command,
    text: decision.text,
    askId: decision.askId,
    reversesCommentId: decision.reversesCommentId,
    via: decision.via,
    decidedAt: decision.decidedAt,
    sourceUrl: decision.sourceUrl,
  };
}

export function itemRequestDtoOf(request: ItemRequestRecord): ItemRequestDto {
  return {
    id: request.id,
    request: request.request,
    requestedAt: request.requestedAt,
    result: request.result,
    reason: request.reason,
    handledAt: request.handledAt,
  };
}
