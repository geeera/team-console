import {
  currentSprintOf,
  freezeOf,
  isInFreeze,
  openSprintsOf,
  type SprintTarget,
  type TrackerSprintDto,
} from '@shared/contracts';

/** Why a sprint choice cannot be sent: there is no such sprint, or (current only) it is inside its freeze window. */
export type QuickTaskSprintDisabledReason = 'missing' | 'frozen';

export interface QuickTaskSprintOption {
  readonly target: SprintTarget;
  /** `null` for the backlog, or when `target` names a sprint that does not exist right now. */
  readonly sprint: TrackerSprintDto | null;
  readonly disabledReason: QuickTaskSprintDisabledReason | null;
}

export interface QuickTaskSprintOptions {
  readonly current: QuickTaskSprintOption;
  readonly next: QuickTaskSprintOption;
  /** Never disabled: the backlog always exists. */
  readonly backlog: QuickTaskSprintOption;
  /** `next`, or `backlog` when there is no next sprint (#107). */
  readonly defaultTarget: SprintTarget;
}

/**
 * Current / Next / Backlog for the quick task form (#107), from the board's own sprint rule (#35/#457):
 * `currentSprintOf` is the earliest open sprint, `next` the one after it in `openSprintsOf`. Current is disabled
 * during its freeze window (#556, the same rule `move-item` uses); either is disabled as `missing` when there is
 * no such sprint. The default is Next, falling back to Backlog when there is no Next.
 */
export function quickTaskSprintOptionsOf(
  sprints: readonly TrackerSprintDto[],
  today: string,
  freezeDays: number,
): QuickTaskSprintOptions {
  const open = openSprintsOf(sprints);
  const current = currentSprintOf(sprints);
  const next = open[1] ?? null;
  const currentFrozen =
    current !== null && current.dueOn !== null && isInFreeze(today, freezeOf(current.dueOn, freezeDays));
  return {
    current: {
      target: 'current',
      sprint: current,
      disabledReason: current === null ? 'missing' : currentFrozen ? 'frozen' : null,
    },
    next: { target: 'next', sprint: next, disabledReason: next === null ? 'missing' : null },
    backlog: { target: 'backlog', sprint: null, disabledReason: null },
    defaultTarget: next === null ? 'backlog' : 'next',
  };
}
