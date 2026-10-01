import type { OverviewTeamState } from '@shared/contracts';
import { decide } from '@worker/run-log';
import type { RunLogView } from './run-log-reader';

// No run carries an empty slot (the marker needs one), so `decide` checks the failure streak only.
const STREAK_ONLY = '';

/**
 * The team's state for the overview (#27), by the rules `runlog start` applies: a `/resume` from the owner after the
 * pause lifts it at the next start; a pause without the owner's record is the team stopping itself after three
 * failed runs; without a pause, three failed runs since the last pause or resume mean the next start stops it.
 */
export function overviewTeamStateOf(view: RunLogView, nowMs: number): OverviewTeamState {
  const isResumed = view.pausedSince !== '' && view.ownerResumeAt > view.pausedSince;
  if (view.paused && !isResumed) {
    return view.ownerPause !== null ? 'paused' : 'failing';
  }
  const resetAt = view.ownerResumeAt > view.pausedSince ? view.ownerResumeAt : view.pausedSince;
  return decide(view.runs, STREAK_ONLY, nowMs, false, resetAt).decision === 'pause' ? 'failing' : 'running';
}
