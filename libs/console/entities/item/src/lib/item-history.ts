import {
  isDecisionCommand,
  isItemKind,
  isItemStatus,
  type ActorDto,
  type CommentDto,
  type DecisionCommand,
  type DecisionDto,
  type ItemEventDto,
  type ItemKind,
  type ItemStatus,
} from '@shared/contracts';

/**
 * One line of a task's History (#409 §3): the item's audited events and its comments, oldest first, each with who
 * and when. Comments are text the owner reads as is; an event is a fixed line the screen words from i18n.
 */
export type HistoryLine =
  | { readonly kind: 'comment'; readonly text: string }
  | { readonly kind: 'created' }
  | { readonly kind: 'imported' }
  | { readonly kind: 'status'; readonly from: ItemStatus | null; readonly to: ItemStatus | null }
  | { readonly kind: 'kind'; readonly from: ItemKind | null; readonly to: ItemKind | null }
  | { readonly kind: 'sprint'; readonly from: number | null; readonly to: number | null }
  | { readonly kind: 'edited' }
  | { readonly kind: 'labels' }
  | { readonly kind: 'closed'; readonly reason: 'done' | 'not-needed' }
  | { readonly kind: 'reopened' }
  | { readonly kind: 'decided'; readonly command: DecisionCommand | null; readonly text: string }
  | { readonly kind: 'asked' }
  | { readonly kind: 'requested' }
  | { readonly kind: 'handled' }
  | { readonly kind: 'pr-linked' }
  | { readonly kind: 'reordered' };

export interface HistoryEntry {
  /** Unique within the item: `e<id>` for an event, `c<id>` for a comment. */
  readonly id: string;
  readonly at: string;
  readonly actor: ActorDto;
  /** The owner's own entry: a filled dot. */
  readonly isOwner: boolean;
  readonly line: HistoryLine;
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function statusOrNull(value: unknown): ItemStatus | null {
  return isItemStatus(value) ? value : null;
}

function sprintOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function eventLineOf(event: ItemEventDto, decisions: ReadonlyMap<number, DecisionDto>): HistoryLine | null {
  const before = recordOf(event.before);
  const after = recordOf(event.after);
  switch (event.kind) {
    case 'created':
      return { kind: 'created' };
    case 'imported':
      return { kind: 'imported' };
    case 'status':
      return { kind: 'status', from: statusOrNull(before['status']), to: statusOrNull(after['status']) };
    case 'sprint':
      return { kind: 'sprint', from: sprintOrNull(before['sprint']), to: sprintOrNull(after['sprint']) };
    case 'edited': {
      const fields = Object.keys(after);
      if (fields.length === 1 && fields[0] === 'kind') {
        return {
          kind: 'kind',
          from: isItemKind(before['kind']) ? before['kind'] : null,
          to: isItemKind(after['kind']) ? after['kind'] : null,
        };
      }
      return { kind: 'edited' };
    }
    case 'labels':
      return { kind: 'labels' };
    case 'closed':
      return { kind: 'closed', reason: after['status'] === 'done' ? 'done' : 'not-needed' };
    case 'reopened':
      return { kind: 'reopened' };
    case 'decided': {
      const id = after['decisionId'];
      const decision = typeof id === 'number' ? decisions.get(id) : undefined;
      const command = isDecisionCommand(after['command']) ? after['command'] : (decision?.command ?? null);
      return { kind: 'decided', command, text: decision?.text ?? '' };
    }
    case 'asked':
      return { kind: 'asked' };
    case 'requested':
      return { kind: 'requested' };
    case 'handled':
      return { kind: 'handled' };
    case 'pr-linked':
      return { kind: 'pr-linked' };
    case 'reordered':
      return { kind: 'reordered' };
    case 'commented':
    case 'answered':
    case 'scrubbed':
      // The comment itself is listed; an ask's answer is the decision's own line. A scrub (#462) changes no field.
      return null;
  }
}

/** Events and comments merged oldest first; equal times keep events before the comment they came with. */
export function historyOf(
  events: readonly ItemEventDto[],
  comments: readonly CommentDto[],
  decisions: readonly DecisionDto[] = [],
): HistoryEntry[] {
  const byId = new Map(decisions.map((decision) => [decision.id, decision]));
  const entries: { readonly entry: HistoryEntry; readonly order: number }[] = [];
  for (const event of events) {
    const line = eventLineOf(event, byId);
    if (line !== null) {
      entries.push({
        entry: {
          id: `e${String(event.id)}`,
          at: event.at,
          actor: event.actor,
          isOwner: event.actor.kind === 'owner',
          line,
        },
        order: 0,
      });
    }
  }
  for (const comment of comments) {
    entries.push({
      entry: {
        id: `c${String(comment.id)}`,
        at: comment.createdAt,
        actor: comment.author,
        isOwner: comment.author.kind === 'owner',
        line: { kind: 'comment', text: comment.body },
      },
      order: 1,
    });
  }
  return entries
    .sort((a, b) => a.entry.at.localeCompare(b.entry.at) || a.order - b.order)
    .map(({ entry }) => entry);
}

/** A line that starts with `/word` reads like a command; a comment never is one, and the form says so. */
export function looksLikeCommand(text: string): boolean {
  return /^\s*\/[a-z-]+/im.test(text);
}
