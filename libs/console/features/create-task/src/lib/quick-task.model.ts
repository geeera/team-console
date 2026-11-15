import type { QuickTaskSprintOption, QuickTaskSprintOptions } from '@console/entities/sprint';
import type { ItemKind, SprintTarget, TrackerSprintDto } from '@shared/contracts';

/** The kinds the owner files from New task (#107); the team's own kinds (finding, wow, question) are not offered. */
export const QUICK_TASK_KINDS = ['feature', 'bug', 'chore'] as const satisfies readonly ItemKind[];
export type QuickTaskKind = (typeof QUICK_TASK_KINDS)[number];

export function isQuickTaskKind(kind: ItemKind): kind is QuickTaskKind {
  return (QUICK_TASK_KINDS as readonly ItemKind[]).includes(kind);
}

/** While the sprints are not read, only the backlog can be named: it needs no sprint number. */
export const BACKLOG_ONLY: QuickTaskSprintOptions = {
  current: { target: 'current', sprint: null, disabledReason: 'missing' },
  next: { target: 'next', sprint: null, disabledReason: 'missing' },
  backlog: { target: 'backlog', sprint: null, disabledReason: null },
  defaultTarget: 'backlog',
};

/**
 * The options with every sprint the server answered 409 `sprint-frozen` for marked frozen too: the local freeze rule
 * reads project.yml's days and may lag the server's, and the form never offers the same sprint again.
 */
export function withRefusedSprints(
  options: QuickTaskSprintOptions,
  frozen: ReadonlySet<number>,
): QuickTaskSprintOptions {
  const mark = (option: QuickTaskSprintOption): QuickTaskSprintOption =>
    option.sprint !== null && frozen.has(option.sprint.number) && option.disabledReason === null
      ? { ...option, disabledReason: 'frozen' }
      : option;
  const current = mark(options.current);
  const next = mark(options.next);
  return {
    ...options,
    current,
    next,
    defaultTarget: next.disabledReason === null ? options.defaultTarget : 'backlog',
  };
}

/** The target the owner chose, or the default when that one cannot be sent right now. */
export function chosenTargetOf(options: QuickTaskSprintOptions, wanted: SprintTarget | null): SprintTarget {
  if (wanted !== null && options[wanted].disabledReason === null) {
    return wanted;
  }
  return options[options.defaultTarget].disabledReason === null ? options.defaultTarget : 'backlog';
}

/** The sprint number `POST …/items` gets for a target: `null` is the backlog. */
export function sprintOf(options: QuickTaskSprintOptions, target: SprintTarget): TrackerSprintDto | null {
  return target === 'backlog' ? null : options[target].sprint;
}

/** A line that reads like an owner command (`/approve`): it stays plain text, and the form says so. */
export function hasCommandLine(text: string): boolean {
  return /^\s*\/\S/mu.test(text);
}
