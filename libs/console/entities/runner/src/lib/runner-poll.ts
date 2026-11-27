import type { PollTimer } from './poll-timer';
import type { RunnerFailure } from './runner-failure';

/** The wait after a 429 that named no `Retry-After`. */
export const RATE_LIMITED_DEFAULT_MS = 60_000;

/** Why a watch stopped on its own: the session ended, the caller lost the owner role, or the thing is not theirs. */
export type RunnerWatchStop = 'session-expired' | 'forbidden' | 'not-found';

/** The wait a 429 asks for, in ms: its `Retry-After`, else `RATE_LIMITED_DEFAULT_MS`. */
export function retryAfterMsOf(failure: RunnerFailure): number {
  const seconds = failure.retryAfterSeconds ?? null;
  return seconds === null ? RATE_LIMITED_DEFAULT_MS : seconds * 1000;
}

/**
 * What a failed read means for a Settings › Runners poll, the same for every watch: a 429 holds the poll and does
 * not end it (#879), a lost session, a lost role or a missing target ends it (the answer to return), and anything
 * else counts as one missed read.
 */
export function pollFailed(poll: PollTimer, failure: RunnerFailure): RunnerWatchStop | null {
  switch (failure.kind) {
    case 'rate-limited':
      poll.rateLimited(retryAfterMsOf(failure));
      return null;
    case 'session-expired':
    case 'forbidden':
    case 'not-found':
      return failure.kind;
    default:
      poll.missed();
      return null;
  }
}
