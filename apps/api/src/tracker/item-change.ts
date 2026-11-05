import type { ItemEventKind, UpdateItemInput } from '@shared/contracts';
import type { FlagsPatch, ItemColumnsPatch, ItemRecord, NewItemEvent } from '@worker/db';
import type { ItemTransition } from '../auth/policy';

/** What a validated `PATCH` does to an item: the columns, the flags, the audit rows and what the policy judges. */
export interface ItemUpdatePlan {
  readonly patch: ItemColumnsPatch;
  readonly flags: FlagsPatch;
  /**
   * One row per kind of change: the lifecycle (`status`, `closed`, `reopened`) first, then the rest (`labels`,
   * `sprint`, `edited`), so the status history stays queryable when a PATCH also edits the title.
   */
  readonly events: readonly NewItemEvent[];
  readonly transition: ItemTransition;
}

export type ItemUpdateOutcome =
  | { readonly kind: 'change'; readonly plan: ItemUpdatePlan }
  /** The request asks for what the item already is: nothing is written, no version is spent. */
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'invalid'; readonly field: string; readonly detail: string };

/** `sprintId` is the id of the sprint `input.sprint` names, already resolved in the project (or `null`). */
export function planItemUpdate(
  item: ItemRecord,
  input: UpdateItemInput,
  sprint: { readonly id: number; readonly number: number } | null | undefined,
  at: string,
): ItemUpdateOutcome {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const patch: Record<string, unknown> = {};
  const record = (field: string, from: unknown, to: unknown, column: Partial<ItemColumnsPatch>): void => {
    if (from !== to) {
      before[field] = from;
      after[field] = to;
      Object.assign(patch, column);
    }
  };

  if (input.title !== undefined) record('title', item.title, input.title, { title: input.title });
  if (input.body !== undefined) record('body', item.body, input.body, { body: input.body });
  if (input.kind !== undefined) record('kind', item.kind, input.kind, { kind: input.kind });
  if (input.severity !== undefined)
    record('severity', item.severity, input.severity, { severity: input.severity });
  if (input.tier !== undefined) record('tier', item.tier, input.tier, { tier: input.tier });
  if (sprint !== undefined) {
    record('sprint', item.sprintNumber, sprint?.number ?? null, { sprintId: sprint?.id ?? null });
  }

  const status = input.status ?? item.status;
  const wasClosed = item.closedAt !== null;
  record('status', item.status, status, { status });
  // `done` is a status and a closing at once; leaving `done` reopens. `state` covers the other two reasons.
  let closedReason = item.closedReason;
  if (status === 'done') {
    closedReason = 'done';
  } else if (item.status === 'done') {
    closedReason = null;
  }
  if (input.state === 'closed') {
    if (status === 'done') {
      return { kind: 'invalid', field: 'state', detail: 'A done item is already closed as done' };
    }
    closedReason = input.closedReason ?? null;
  } else if (input.state === 'open') {
    if (status === 'done') {
      return {
        kind: 'invalid',
        field: 'status',
        detail: 'Reopening a done item needs a status other than done',
      };
    }
    closedReason = null;
  }
  const isClosed = closedReason !== null;
  if (closedReason !== item.closedReason) {
    before['closedReason'] = item.closedReason;
    after['closedReason'] = closedReason;
    patch['closedReason'] = closedReason;
    patch['closedAt'] = isClosed ? (wasClosed ? item.closedAt : at) : null;
  }

  const current = new Set(item.flags);
  const add = (input.addLabels ?? []).filter((flag) => !current.has(flag));
  const remove = (input.removeLabels ?? []).filter((flag) => current.has(flag));
  const flags = [...item.flags.filter((flag) => !remove.includes(flag)), ...add].sort();
  if (add.length > 0 || remove.length > 0) {
    before['flags'] = item.flags;
    after['flags'] = flags;
  }

  const changed = Object.keys(after);
  if (changed.length === 0) {
    return { kind: 'unchanged' };
  }
  return {
    kind: 'change',
    plan: {
      patch: patch as ItemColumnsPatch,
      flags: { add, remove },
      events: eventsOf(before, after, wasClosed, isClosed),
      transition: {
        before: { status: item.status, flags: item.flags, closed: wasClosed },
        after: { status, flags, closed: isClosed },
        changesOtherFields: changed.some((field) => !['status', 'flags', 'closedReason'].includes(field)),
      },
    },
  };
}

const LIFECYCLE_FIELDS: readonly string[] = ['status', 'closedReason'];

function eventsOf(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
  wasClosed: boolean,
  isClosed: boolean,
): NewItemEvent[] {
  const part = (fields: readonly string[]) => ({
    before: Object.fromEntries(fields.map((field) => [field, before[field]])),
    after: Object.fromEntries(fields.map((field) => [field, after[field]])),
  });
  const changed = Object.keys(after);
  const lifecycle = changed.filter((field) => LIFECYCLE_FIELDS.includes(field));
  const rest = changed.filter((field) => !LIFECYCLE_FIELDS.includes(field));
  const events: NewItemEvent[] = [];
  if (lifecycle.length > 0) {
    const kind: ItemEventKind =
      !wasClosed && isClosed
        ? 'closed'
        : wasClosed && !isClosed
          ? 'reopened'
          : lifecycle.includes('status')
            ? 'status'
            : 'closed';
    events.push({ kind, ...part(lifecycle) });
  }
  if (rest.length > 0) {
    const [only] = rest;
    const kind: ItemEventKind =
      rest.length === 1 && only === 'flags'
        ? 'labels'
        : rest.length === 1 && only === 'sprint'
          ? 'sprint'
          : 'edited';
    events.push({ kind, ...part(rest) });
  }
  return events;
}
