import type { PauseRunnerInput } from '@shared/contracts';
import type { IsolationBackend } from '../backends/backend';
import { MAX_PAUSE_MS } from '../budget/detect';
import { activePause, loadRunnerState, saveRunnerState, type RunnerPause, type RunnerState } from '../budget/state';
import type { ClaimOutcome } from '../client/runner-client';
import type { RunnerConfig } from '../config/config';
import { JobRegistry } from '../proxy/job-registry';
import { runJob, type JobConsole, type JobReport, type JobRunDeps } from './run-job';

/**
 * `run-once` and `run --loop` (architect note on #468, PR 2): claim, run, repeat. The local pause of decision 9 is
 * honoured before every claim, including across restarts (`state.json`); one job at a time (`maxConcurrency` 1).
 * The backend's preflight runs before each claim, so a job never starts while a previous one's process remains.
 * The pause is mirrored to the console (#571) so its claim skips this runner too and Settings › Runners shows it.
 */

export interface LoopConsole extends JobConsole {
  claim(): Promise<ClaimOutcome>;
  pause(input: PauseRunnerInput): Promise<void>;
  resume(): Promise<void>;
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

/** Room for the runner's clock running ahead of the console's: the console refuses an `until` past 24 h. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

/** The pause as the console takes it: never further ahead than its 24 h bound, less the skew allowance. */
export function mirroredPauseOf(pause: RunnerPause, now: Date): PauseRunnerInput {
  const latest = now.getTime() + MAX_PAUSE_MS - CLOCK_SKEW_MS;
  return { reason: pause.reason, until: new Date(Math.min(Date.parse(pause.until), latest)).toISOString() };
}

/**
 * Posts the pause in force (or its end) when it differs from what was last mirrored. The local pause is the
 * enforcement, so a console that cannot be reached is logged and tried again on the next change, never fatal.
 */
async function mirrorPause(
  deps: LoopDeps,
  pause: RunnerPause | null,
  mirrored: RunnerPause | null,
): Promise<RunnerPause | null> {
  if (pause?.reason === mirrored?.reason && pause?.until === mirrored?.until) {
    return mirrored;
  }
  try {
    if (pause === null) {
      await deps.client.resume();
    } else {
      await deps.client.pause(mirroredPauseOf(pause, deps.now()));
    }
    return pause;
  } catch (error: unknown) {
    deps.log(
      `could not ${pause === null ? 'clear the pause on' : 'mirror the pause to'} the console: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
    return mirrored;
  }
}

export async function runLoop(mode: 'once' | 'loop', deps: LoopDeps): Promise<LoopEnd> {
  const sleep = deps.sleep ?? abortableSleep;
  const registry = new JobRegistry();
  let state = await loadRunnerState(deps.home);
  // Nothing mirrored yet in this process: a pause still in force from `state.json` is posted again on start.
  let mirrored: RunnerPause | null = null;
  while (!deps.shutdown.aborted) {
    const pause = activePause(state, deps.now());
    mirrored = await mirrorPause(deps, pause, mirrored);
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
    mirrored = await mirrorPause(deps, activePause(state, deps.now()), mirrored);
    if (mode === 'once') {
      return 'ran';
    }
  }
  return 'shutdown';
}
