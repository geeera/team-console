import { BUDGET_PAUSER, budgetOf, type TeamBudgetMonthDto, type TeamState } from '@shared/contracts';
import {
  FAILURE_STREAK_PAUSER,
  ProjectSpendRepo,
  TeamConfigRepo,
  TeamStateRepo,
  utcMonthOf,
  type TeamStateRecord,
} from '@worker/db';

/**
 * The team's state on the console's tracker (#738, #731): `team_state` is the pause the claim honours, so the status,
 * the panel and Run now read it rather than the GitHub run log.
 */
export interface ConsoleTeamState {
  readonly state: TeamState;
  readonly pausedAt: string | null;
}

/**
 * Who paused, by `paused_by`. Only the two system pausers are named; any other actor is a person pausing from the
 * console, which reads as the owner's pause.
 */
export function teamStateOf(record: Pick<TeamStateRecord, 'pausedAt' | 'pausedBy'>): ConsoleTeamState {
  if (record.pausedAt === null) {
    return { state: 'running', pausedAt: null };
  }
  const state: TeamState =
    record.pausedBy === BUDGET_PAUSER
      ? 'paused-by-budget'
      : record.pausedBy === FAILURE_STREAK_PAUSER
        ? 'paused-by-team'
        : 'paused-by-owner';
  return { state, pausedAt: record.pausedAt };
}

export async function consoleTeamStateOf(db: D1Database, projectSlug: string): Promise<ConsoleTeamState> {
  return teamStateOf(await new TeamStateRepo(db).get(projectSlug));
}

/** The UTC month of `now` against the budget saved now, with the month's waiver (#737). */
export async function budgetMonthOf(db: D1Database, projectSlug: string, now: string): Promise<TeamBudgetMonthDto> {
  const [spend, config] = await Promise.all([
    new ProjectSpendRepo(db).findMonth(projectSlug, utcMonthOf(now)),
    new TeamConfigRepo(db).findCurrent(projectSlug),
  ]);
  return {
    month: spend.month,
    spentUsd: spend.spentUsd,
    budgetUsd: budgetOf(config?.config ?? null).monthly_usd,
    waivedAt: spend.waivedAt,
  };
}
