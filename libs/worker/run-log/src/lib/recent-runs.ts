import { effectiveState, type Run } from './run-state';

/** A run as the console shows it; see `shownStateOf`. */
export type ShownRunState = 'running' | 'finished' | 'failed' | 'unknown';

export interface RecentRun {
  readonly id: string;
  /** The run-log slot name (`slot-dev`). */
  readonly slot: string;
  readonly state: ShownRunState;
  /** When the run ended, or when it started while it has not; `null` when GitHub sent no time. */
  readonly at: string | null;
}

/**
 * `effective_state` for display, with the provenance rule made strict: a run a team entry was edited on
 * (`trusted: false`, see `parseRuns`) is `unknown` whatever its state, so an edit can never put "failed" (nor
 * "running") on the board. Outsiders' entries never reach a run at all. A state the plugin may add later is
 * `unknown` rather than read as a success.
 */
export function shownStateOf(run: Run, nowMs: number): ShownRunState {
  if (!run.trusted) {
    return 'unknown';
  }
  const state = effectiveState(run, nowMs);
  if (state === 'started') {
    return 'running';
  }
  if (state === 'finished') {
    return 'finished';
  }
  return state === 'failed' ? 'failed' : 'unknown';
}

/** The latest `limit` runs (by start, as `parseRuns` orders them), newest first. */
export function recentRunsOf(runs: readonly Run[], nowMs: number, limit: number): RecentRun[] {
  const count = Math.max(0, Math.floor(limit));
  if (count === 0) {
    return [];
  }
  return runs
    .slice(-count)
    .reverse()
    .map((run) => {
      const state = shownStateOf(run, nowMs);
      return {
        id: run.id,
        slot: run.slot,
        state,
        at: state === 'running' ? run.at : (run.finishedAt ?? run.at),
      };
    });
}
