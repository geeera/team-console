import { rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { RunnerFileError, pathExists, readPrivateFile, writePrivateFile } from '../config/private-files';
import type { LimitReason } from './detect';

/**
 * The runner's local pause (ADR 0008 decision 9), kept in `state.json` 0600 so a restart honours it: no claim before
 * `pause.until`. `limitStreak` drives the back-off and is reset by a successful job. A file the runner cannot read is
 * refused, never replaced: dropping it would silently lift a pause.
 */

export const STATE_FILE = 'state.json';

export interface RunnerPause {
  readonly reason: LimitReason;
  readonly until: string;
}

export interface RunnerState {
  readonly schema: 1;
  readonly pause: RunnerPause | null;
  readonly limitStreak: number;
}

export const EMPTY_STATE: RunnerState = { schema: 1, pause: null, limitStreak: 0 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPause(value: unknown): value is RunnerPause {
  return (
    isRecord(value) &&
    (value['reason'] === 'usage-limit' || value['reason'] === 'rate-limit') &&
    typeof value['until'] === 'string' &&
    !Number.isNaN(Date.parse(value['until']))
  );
}

export function parseRunnerState(value: unknown): RunnerState {
  if (
    !isRecord(value) ||
    value['schema'] !== 1 ||
    !(value['pause'] === null || isPause(value['pause'])) ||
    !Number.isSafeInteger(value['limitStreak']) ||
    (value['limitStreak'] as number) < 0
  ) {
    throw new RunnerFileError(
      'config-invalid',
      `${STATE_FILE} is not a runner state; fix or remove it by hand`,
    );
  }
  const pause = value['pause'] as RunnerPause | null;
  return {
    schema: 1,
    pause: pause === null ? null : { reason: pause.reason, until: pause.until },
    limitStreak: value['limitStreak'] as number,
  };
}

export async function loadRunnerState(home: string): Promise<RunnerState> {
  const path = join(home, STATE_FILE);
  if (!(await pathExists(path))) {
    return EMPTY_STATE;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readPrivateFile(path));
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      throw new RunnerFileError(
        'config-invalid',
        `${STATE_FILE} is not valid JSON; fix or remove it by hand`,
      );
    }
    throw error;
  }
  return parseRunnerState(parsed);
}

/** Written to a sibling and renamed over, so a crash never leaves half a file. */
export async function saveRunnerState(home: string, state: RunnerState): Promise<void> {
  const path = join(home, STATE_FILE);
  const next = `${path}.next`;
  await rm(next, { force: true });
  await writePrivateFile(next, `${JSON.stringify(parseRunnerState(state))}\n`);
  await rename(next, path);
}

/** The pause still in force at `now`, or `null`. */
export function activePause(state: RunnerState, now: Date): RunnerPause | null {
  return state.pause !== null && Date.parse(state.pause.until) > now.getTime() ? state.pause : null;
}
