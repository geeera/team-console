import {
  addDays,
  freezeOf,
  isInFreeze,
  sprintTitleOf,
  type MoveDemoRequest,
  type NextSprintRequest,
  type SprintCalendarDto,
  type SprintFreezeDto,
  type SprintRefDto,
  type TeamSprintDto,
} from '@shared/contracts';
import {
  demoDayOfMilestone,
  nextSprintNumber,
  pickCurrentSprint,
  pickNextSprint,
  type MilestoneRecord,
} from '@worker/read-models';

/**
 * The sprint calendar as the plugin will read it on its next run (#218): the current sprint
 * (`calendar.pick_current_sprint`), the one after it, the title a new sprint gets, and the freeze, all in Kyiv
 * days. Pure: the routes read the milestones live and decide here, so every refusal is unit-tested.
 */
export interface SprintPlan {
  readonly today: string;
  readonly freezeDays: number;
  readonly current: SprintRefDto | null;
  readonly next: SprintRefDto | null;
  readonly nextTitle: string;
}

function refOf(milestone: MilestoneRecord): SprintRefDto {
  return { number: milestone.number, title: milestone.title, due: demoDayOfMilestone(milestone) ?? '' };
}

/** `milestones`: every milestone, open and closed (`state=all`), so the next title never repeats a closed one. */
export function sprintPlanOf(
  milestones: readonly MilestoneRecord[],
  today: string,
  freezeDays: number,
): SprintPlan {
  const current = pickCurrentSprint(milestones, today);
  const next = current === null ? null : pickNextSprint(milestones, current);
  return {
    today,
    freezeDays,
    current: current === null ? null : refOf(current),
    next: next === null ? null : refOf(next),
    nextTitle: sprintTitleOf(nextSprintNumber(milestones)),
  };
}

export function freezeOfDue(plan: SprintPlan, due: string): SprintFreezeDto {
  return freezeOf(due, plan.freezeDays);
}

/** The status card's sprint (`TeamStatusDto.sprint`); `null` without a current sprint. */
export function teamSprintOf(plan: SprintPlan): TeamSprintDto | null {
  return plan.current === null
    ? null
    : { ...plan.current, freeze: freezeOfDue(plan, plan.current.due), next: plan.next };
}

export function calendarOf(plan: SprintPlan): SprintCalendarDto {
  return { today: plan.today, freezeDays: plan.freezeDays, nextTitle: plan.nextTitle };
}

export type MoveDemoRefusal =
  | { readonly type: 'sprint-none' }
  | { readonly type: 'sprint-changed'; readonly due: string }
  | { readonly type: 'sprint-unchanged' }
  | { readonly type: 'sprint-date-past'; readonly today: string }
  | { readonly type: 'sprint-date-after-next'; readonly next: SprintRefDto };

/**
 * Why the demo cannot move to `request.due`, in the order the architect note gives (#29 §1), or `null` when it can.
 * `request` has been validated: both days are calendar dates.
 */
export function moveDemoRefusal(plan: SprintPlan, request: MoveDemoRequest): MoveDemoRefusal | null {
  const current = plan.current;
  if (current === null) {
    return { type: 'sprint-none' };
  }
  if (request.expectedDue !== current.due) {
    return { type: 'sprint-changed', due: current.due };
  }
  if (request.due === current.due) {
    return { type: 'sprint-unchanged' };
  }
  if (request.due < plan.today) {
    return { type: 'sprint-date-past', today: plan.today };
  }
  if (plan.next !== null && request.due >= plan.next.due) {
    return { type: 'sprint-date-after-next', next: plan.next };
  }
  return null;
}

/** Today lands inside the freeze of the moved demo: the next run takes no new issues. */
export function freezeStartsNow(plan: SprintPlan, due: string): boolean {
  return isInFreeze(plan.today, freezeOfDue(plan, due));
}

export type NextSprintRefusal =
  | { readonly type: 'sprint-changed'; readonly current: SprintRefDto | null }
  | { readonly type: 'sprint-exists'; readonly title: string; readonly due: string | null }
  | { readonly type: 'sprint-date-early'; readonly after: string };

/** Why the next sprint cannot be created with `request.due` (#29 §2), or `null` when it can. */
export function nextSprintRefusal(plan: SprintPlan, request: NextSprintRequest): NextSprintRefusal | null {
  const current = plan.current;
  if ((current?.title ?? null) !== request.expectedCurrent) {
    return { type: 'sprint-changed', current };
  }
  if (plan.next !== null) {
    return { type: 'sprint-exists', title: plan.next.title, due: plan.next.due };
  }
  // With a current sprint the new demo must come after it; without one, any day from today on (it becomes current).
  const after = current === null ? addDays(plan.today, -1) : current.due;
  if (request.due <= after) {
    return { type: 'sprint-date-early', after };
  }
  return null;
}
