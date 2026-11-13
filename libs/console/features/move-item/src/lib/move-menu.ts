import type { MenuGroup, MenuItem, MenuSpec } from '@console/shared/ui';
import {
  freezeOf,
  isInFreeze,
  isQueueMove,
  type ItemSummaryDto,
  type QueueMove,
  type QueuePositionDto,
  type TrackerSprintDto,
} from '@shared/contracts';

/** The team's usual sprint size (the #310 plan's 8): from it, a sprint's item warns, never blocks (#409 §2.2). */
export const SPRINT_CAP = 8;

/** What the Move menu needs to know, all already read. */
export interface MoveMenuInput {
  readonly item: Pick<ItemSummaryDto, 'sprint' | 'status' | 'title'>;
  /** The task's place in its lane (#456); `null` for a task on no board, which has no queue group. */
  readonly queue: QueuePositionDto | null;
  /** Open sprints, earliest first: the first is the current one. */
  readonly sprints: readonly TrackerSprintDto[];
  /** Open items per sprint number (`null` = the backlog). */
  readonly counts: ReadonlyMap<number | null, number>;
  readonly today: string;
  readonly freezeDays: number;
}

/** The words the menu shows, already translated by the caller. */
export interface MoveMenuCopy {
  readonly label: string;
  readonly title: string;
  readonly sprintsGroup: string;
  readonly to: (sprint: TrackerSprintDto) => string;
  readonly toCurrent: (sprint: TrackerSprintDto) => string;
  readonly toBacklog: string;
  readonly count: (n: number, sprint: TrackerSprintDto) => string;
  readonly backlogCount: (n: number) => string;
  readonly full: (n: number) => string;
  readonly here: string;
  readonly freeze: (sprint: TrackerSprintDto) => string;
  readonly inProgress: string;
  /** The queue group (#456): its heading names the lane ("Queue · Approved"), then First / Up / Down and their reasons. */
  readonly queueGroup: string;
  readonly first: string;
  readonly up: string;
  readonly down: string;
  readonly alreadyFirst: string;
  readonly alreadyLast: string;
}

/** The menu item id of a target: `sprint:3` or `backlog`. */
export type MoveTarget = number | null;

export function moveTargetOf(id: string): MoveTarget | undefined {
  if (id === 'backlog') {
    return null;
  }
  const match = /^sprint:([1-9][0-9]*)$/.exec(id);
  return match === null ? undefined : Number(match[1]);
}

/** The queue move a menu item id names (`queue:first`), or `undefined` for a sprint target. */
export function queueMoveOf(id: string): QueueMove | undefined {
  const move = id.startsWith('queue:') ? id.slice('queue:'.length) : '';
  return isQueueMove(move) ? move : undefined;
}

/**
 * First in the queue / Up / Down for a task at `queue.position` of `queue.total` (#409 §2.2, #456). Off items keep
 * their place with the reason: First and Up on the first task, Down on the last.
 */
export function queueItemsOf(queue: QueuePositionDto, copy: MoveMenuCopy): MenuItem[] {
  const isFirst = queue.position <= 1;
  const isLast = queue.position >= queue.total;
  return [
    { id: 'queue:first', label: copy.first, ...(isFirst ? { off: copy.alreadyFirst } : {}) },
    { id: 'queue:up', label: copy.up, ...(isFirst ? { off: copy.alreadyFirst } : {}) },
    { id: 'queue:down', label: copy.down, ...(isLast ? { off: copy.alreadyLast } : {}) },
  ];
}

/**
 * The Move menu of #409 §2.2: the queue group first (First in the queue / Up / Down within the task's lane, #456),
 * then every open sprint ("To Sprint 03 — current", "To Sprint 04"), each with "{n} tasks · demo {date}", then "To
 * the backlog". Off items keep their place with the reason: already first or last, where the task is now, the current
 * sprint during its freeze. A sprint at or over `SPRINT_CAP` warns. A task in progress gets the note on top.
 */
export function moveMenuOf(input: MoveMenuInput, copy: MoveMenuCopy): MenuSpec {
  const { item, sprints, counts } = input;
  const current = sprints[0] ?? null;
  const sprintItems: MenuItem[] = sprints.map((sprint) => {
    const n = counts.get(sprint.number) ?? 0;
    const isCurrent = sprint === current;
    const isFrozen =
      isCurrent && sprint.dueOn !== null && isInFreeze(input.today, freezeOf(sprint.dueOn, input.freezeDays));
    const off = item.sprint === sprint.number ? copy.here : isFrozen ? copy.freeze(sprint) : undefined;
    const isFull = n >= SPRINT_CAP && off === undefined;
    return {
      id: `sprint:${String(sprint.number)}`,
      label: isCurrent ? copy.toCurrent(sprint) : copy.to(sprint),
      hint: isFull ? copy.full(n) : copy.count(n, sprint),
      ...(isFull ? { hintTone: 'warning' as const } : {}),
      ...(off === undefined ? {} : { off }),
    };
  });
  const backlog: MenuItem = {
    id: 'backlog',
    label: copy.toBacklog,
    hint: copy.backlogCount(counts.get(null) ?? 0),
    ...(item.sprint === null ? { off: copy.here } : {}),
  };
  const groups: MenuGroup[] = [
    ...(input.queue === null ? [] : [{ label: copy.queueGroup, items: queueItemsOf(input.queue, copy) }]),
    { label: copy.sprintsGroup, items: sprintItems },
    { items: [backlog] },
  ];
  return {
    label: copy.label,
    title: copy.title,
    subtitle: item.title,
    ...(item.status === 'in-progress' ? { warning: copy.inProgress } : {}),
    groups,
  };
}
