import {
  isRunnerStoredCheckReason,
  type RunnerCheckReadDto,
  type RunnerCheckState,
  type RunnerStoredCheckReason,
} from '@shared/contracts';

/** A failure code this console does not know (a newer API): shown as the generic state, never as the code itself. */
export const UNKNOWN_CHECK_REASON = 'unknown';
export type RunnerCheckOutcome = RunnerStoredCheckReason | typeof UNKNOWN_CHECK_REASON;

/**
 * A runner check as the console holds it (#1059 PR 3): the API's DTO, with a reason this build does not know folded
 * into `UNKNOWN_CHECK_REASON`, so no code from the wire is ever kept, let alone rendered.
 */
export interface RunnerCheck extends Omit<RunnerCheckReadDto, 'reason'> {
  readonly reason: RunnerCheckOutcome | null;
}

export function runnerCheckOf(read: RunnerCheckReadDto): RunnerCheck {
  const reason =
    read.reason === null ? null : isRunnerStoredCheckReason(read.reason) ? read.reason : UNKNOWN_CHECK_REASON;
  return { ...read, reason };
}

/** `passed` and `failed` never change again, so a watch stops there. */
export function isFinalCheckState(state: RunnerCheckState): boolean {
  return state === 'passed' || state === 'failed';
}
