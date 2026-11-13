/**
 * Fixed-window counters in D1 (#467, ADR 0008 "Customer runner authentication without Access"): the Worker's own
 * rate limits where a WAF rule cannot apply (workers.dev has no zone). One row per key; the window is the bucket
 * `rateWindowOf` names, and a hit outside the stored window starts a new count.
 */
export interface RateLimitOutcome {
  readonly allowed: boolean;
  readonly count: number;
}

export class RateLimitsRepo {
  constructor(private readonly db: D1Database) {}

  /**
   * One hit on `key` inside `window` (a label from `rateWindowOf`), allowed while the count stays at or under `limit`.
   * A single UPSERT, so concurrent hits are counted, not lost.
   */
  async hit(key: string, window: string, limit: number): Promise<RateLimitOutcome> {
    const [, upsert] = await this.db.batch<{ count: number }>([
      // Rows of past windows are swept on every hit (#489 review), as the nonce rows are: a flood of addresses leaves
      // nothing behind once its window has passed. Labels are window starts in epoch seconds whatever the window's
      // length (#537), so a row older than the longest window has ended, and a minute counter's sweep never resets a
      // 10-minute one.
      this.db
        .prepare(`DELETE FROM rate_limits WHERE CAST(window_start AS INTEGER) < CAST(?1 AS INTEGER) - ?2`)
        .bind(window, RATE_WINDOW_MAX_SECONDS),
      this.db
        .prepare(
          `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
           ON CONFLICT (key) DO UPDATE SET
             count = CASE WHEN window_start = excluded.window_start THEN count + 1 ELSE 1 END,
             window_start = excluded.window_start
           RETURNING count`,
        )
        .bind(key, window),
    ]);
    const count = upsert?.results[0]?.count ?? limit + 1;
    return { allowed: count <= limit, count };
  }
}

/** The longest window a caller may name: the sweep keeps every row that started less than this long ago. */
export const RATE_WINDOW_MAX_SECONDS = 3600;

function checkedWindowSeconds(seconds: number): number {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > RATE_WINDOW_MAX_SECONDS) {
    throw new RangeError(`a rate window is 1..${String(RATE_WINDOW_MAX_SECONDS)} whole seconds`);
  }
  return seconds;
}

/**
 * The fixed window of `seconds` that `at` (epoch ms) falls in, as its label: the window's start in epoch seconds. One
 * scale for every window length, which the sweep in `hit` relies on.
 */
export function rateWindowOf(at: number, seconds: number): string {
  const atSeconds = Math.floor(at / 1000);
  return String(atSeconds - (atSeconds % checkedWindowSeconds(seconds)));
}

/** Whole seconds from `at` (epoch ms) to the end of its window of `seconds`: a `Retry-After` value, 1..seconds. */
export function retryAfterOf(at: number, seconds: number): number {
  return checkedWindowSeconds(seconds) - (Math.floor(at / 1000) % seconds);
}
