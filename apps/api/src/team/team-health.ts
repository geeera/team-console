import {
  RECENT_RUNS_LIMIT,
  TEAM_SLOTS,
  type OverviewTeamState,
  type RecentRunDto,
  type TeamRunDto,
  type TeamSlot,
} from '@shared/contracts';
import { githubUrlOrNull } from '@worker/read-models';
import { RUN_LOG_SLOTS, decide, recentRunsOf } from '@worker/run-log';
import type { RunLogView } from './run-log-reader';

// No run carries an empty slot (the marker needs one), so `decide` checks the failure streak only.
const STREAK_ONLY = '';

/**
 * The team's state for the overview (#27) and the board (#132), by the rules `runlog start` applies: a `/resume` from
 * the owner after the pause lifts it at the next start; a pause without the owner's record is the team stopping
 * itself after three failed runs; without a pause, three failed runs since the last pause or resume mean the next
 * start stops it.
 */
export function overviewTeamStateOf(view: RunLogView, nowMs: number): OverviewTeamState {
  const isResumed = view.pausedSince !== '' && view.ownerResumeAt > view.pausedSince;
  if (view.paused && !isResumed) {
    return view.ownerPause !== null ? 'paused' : 'failing';
  }
  const resetAt = view.ownerResumeAt > view.pausedSince ? view.ownerResumeAt : view.pausedSince;
  return decide(view.runs, STREAK_ONLY, nowMs, false, resetAt).decision === 'pause' ? 'failing' : 'running';
}

/** The run log could not be used (or read): the state is unknown and nothing is listed. */
export const UNKNOWN_TEAM_RUN: TeamRunDto = { state: 'unknown', runLogUrl: null, recentRuns: [] };

function teamSlotOf(name: string): TeamSlot | null {
  return TEAM_SLOTS.find((slot) => RUN_LOG_SLOTS[slot] === name) ?? null;
}

/** The team's state and its latest runs as the board shows them (#132); edited entries make a run `unknown`. */
export function teamRunOf(view: RunLogView, nowMs: number): TeamRunDto {
  const recentRuns = recentRunsOf(view.runs, nowMs, RECENT_RUNS_LIMIT).map((run): RecentRunDto => ({
    slot: teamSlotOf(run.slot),
    slotName: run.slot,
    state: run.state,
    at: run.at,
  }));
  return {
    state: overviewTeamStateOf(view, nowMs),
    runLogUrl: view.issue === null ? null : githubUrlOrNull(view.issue.htmlUrl),
    recentRuns,
  };
}
