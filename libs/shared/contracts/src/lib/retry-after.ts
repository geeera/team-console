/** A wait under a second would let a client spin on a `Retry-After: 0` while it is being limited (#133, #813). */
export const RETRY_AFTER_MIN_SECONDS = 1;
/** An hour: beyond it a client would rather ask again, and `setTimeout` overflows near 2^31 ms anyway (#813). */
export const RETRY_AFTER_MAX_SECONDS = 3600;

const DELTA_SECONDS = /^\d+$/;
// RFC 9110 IMF-fixdate only: `Date.parse` alone takes nearly anything (`Date.parse('1')` is a date in V8).
const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/** Rounds a wait up to whole seconds within 1..3600; a NaN waits the longest rather than not at all. */
export function boundedRetryAfterSeconds(seconds: number): number {
  if (Number.isNaN(seconds)) {
    return RETRY_AFTER_MAX_SECONDS;
  }
  return Math.min(Math.max(Math.ceil(seconds), RETRY_AFTER_MIN_SECONDS), RETRY_AFTER_MAX_SECONDS);
}

export interface RetryAfterOptions {
  /**
   * What "retry now" (`0`, or a date already past) answers: the 1 s floor (the default), or `null` so the caller
   * waits its own default instead (the console's choice, #133).
   */
  readonly retryNow?: 'floor' | 'absent';
}

function rawSecondsOf(raw: string, nowMs: number): number | null {
  if (DELTA_SECONDS.test(raw)) {
    return Number(raw);
  }
  if (IMF_FIXDATE.test(raw)) {
    const at = Date.parse(raw);
    return Number.isFinite(at) ? (at - nowMs) / 1000 : null;
  }
  return null;
}

/**
 * Seconds to wait from a `Retry-After` value, bounded to 1..3600: delta-seconds as sent, an HTTP-date as the seconds
 * from `nowMs` until it. `null` for anything else (missing, blank, negative, fractional, another date format), so the
 * caller applies its own default.
 */
export function retryAfterSecondsOf(
  value: string | null | undefined,
  nowMs: number,
  options: RetryAfterOptions = {},
): number | null {
  const seconds = rawSecondsOf(value?.trim() ?? '', nowMs);
  if (seconds === null || (seconds <= 0 && options.retryNow === 'absent')) {
    return null;
  }
  return boundedRetryAfterSeconds(seconds);
}
