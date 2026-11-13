import type { IsolationBackend } from '../backends/backend';
import { activePause, loadRunnerState, saveRunnerState, type RunnerState } from '../budget/state';
import type { ClaimOutcome } from '../client/runner-client';
import type { RunnerConfig } from '../config/config';
import { JobRegistry } from '../proxy/job-registry';
import { runJob, type JobConsole, type JobReport, type JobRunDeps } from './run-job';

/**
 * `run-once` and `run --loop` (architect note on #468, PR 2): claim, run, repeat. The local pause of decision 9 is
 * honoured before every claim, including across restarts (`state.json`); one job at a time (`maxConcurrency` 1).
 * The backend's preflight runs before each claim, so a job never starts while a previous one's process remains.
 */

export interface LoopConsole extends JobConsole {
  claim(): Promise<ClaimOutcome>;
}

export interface LoopDeps {
  readonly home: string;
  readonly config: RunnerConfig;
  readonly client: LoopConsole;
  readonly backend: IsolationBackend;
  readonly sourceEnv: Readonly<Record<string, string | undefined>>;
  readonly log: (line: string) => void;
  readonly now: () => Date;
  readonly shutdown: AbortSignal;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly timing?: Pick<JobRunDeps, 'heartbeatMs' | 'flushMs' | 'minuteMs'>;
}

export type LoopEnd = 'ran' | 'idle' | 'paused' | 'shutdown';

const abortableSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, Math.max(0, ms));
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done);
  });

/** The state after a job: a limit pauses and counts, a success resets the back-off, another failure keeps it. */
export function stateAfter(state: RunnerState, report: JobReport): RunnerState {
  if (report.limit !== null) {
    return {
      schema: 1,
      pause: { reason: report.limit.reason, until: report.limit.retryAt },
      limitStreak: state.limitStreak + 1,
    };
  }
  return report.result === 'finished'
    ? { schema: 1, pause: null, limitStreak: 0 }
    : { ...state, pause: null };
}

export async function runLoop(mode: 'once' | 'loop', deps: LoopDeps): Promise<LoopEnd> {
  const sleep = deps.sleep ?? abortableSleep;
  const registry = new JobRegistry();
  let state = await loadRunnerState(deps.home);
  while (!deps.shutdown.aborted) {
    const pause = activePause(state, deps.now());
    if (pause !== null) {
      deps.log(`paused (${pause.reason}) until ${pause.until}; not claiming`);
      if (mode === 'once') {
        return 'paused';
      }
      await sleep(Date.parse(pause.until) - deps.now().getTime(), deps.shutdown);
      continue;
    }
    await deps.backend.preflight();
    let claim: ClaimOutcome;
    try {
      claim = await deps.client.claim();
    } catch (error: unknown) {
      if (mode === 'once') {
        throw error;
      }
      deps.log(`claim failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      await sleep(deps.config.pollSeconds * 1000, deps.shutdown);
      continue;
    }
    if (claim.kind === 'idle') {
      if (mode === 'once') {
        return 'idle';
      }
      await sleep(claim.retryAfterSeconds * 1000, deps.shutdown);
      continue;
    }
    deps.log(`claimed job ${claim.job.id} (${claim.job.kind})`);
    const report = await runJob(claim.job, claim.jobToken, {
      home: deps.home,
      config: deps.config,
      client: deps.client,
      backend: deps.backend,
      registry,
      sourceEnv: deps.sourceEnv,
      log: deps.log,
      now: deps.now,
      shutdown: deps.shutdown,
      limitStreak: state.limitStreak,
      ...deps.timing,
    });
    state = stateAfter(state, report);
    await saveRunnerState(deps.home, state);
    if (mode === 'once') {
      return 'ran';
    }
  }
  return 'shutdown';
}
