import type { MenuGroup, MenuItem, MenuSpec } from '@console/shared/ui';
import { freezeOf, isInFreeze, type ItemSummaryDto, type TrackerSprintDto } from '@shared/contracts';

/** The team's usual sprint size (the #310 plan's 8): from it, a sprint's item warns, never blocks (#409 §2.2). */
export const SPRINT_CAP = 8;

/** What the Move menu needs to know, all already read. */
export interface MoveMenuInput {
  readonly item: Pick<ItemSummaryDto, 'sprint' | 'status' | 'title'>;
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

/**
 * The Move menu of #409 §2.2: every open sprint ("To Sprint 03 — current", "To Sprint 04"), each with "{n} tasks ·
 * demo {date}", then "To the backlog". Off items keep their place with the reason: where the task is now, the current
 * sprint during its freeze. A sprint at or over `SPRINT_CAP` warns. A task in progress gets the note on top.
 * (The queue items First / Up / Down need an order the tracker does not keep yet; they are not offered.)
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
  const groups: MenuGroup[] = [{ label: copy.sprintsGroup, items: sprintItems }, { items: [backlog] }];
  return {
    label: copy.label,
    title: copy.title,
    subtitle: item.title,
    ...(item.status === 'in-progress' ? { warning: copy.inProgress } : {}),
    groups,
  };
}
