/**
 * Fixed-window counters in D1 (#467, ADR 0008 "Customer runner authentication without Access"): the Worker's own
 * rate limits where a WAF rule cannot apply (workers.dev has no zone). One row per key; the window is the ISO
 * minute (or any bucket the caller names), and a hit outside the stored window starts a new count.
 */
export interface RateLimitOutcome {
  readonly allowed: boolean;
  readonly count: number;
}

export class RateLimitsRepo {
  constructor(private readonly db: D1Database) {}

  /**
   * One hit on `key` inside `window` (a bucket label such as `2026-11-10T14:03`), allowed while the count stays at
   * or under `limit`. A single UPSERT, so concurrent hits are counted, not lost.
   */
  async hit(key: string, window: string, limit: number): Promise<RateLimitOutcome> {
    const [, upsert] = await this.db.batch<{ count: number }>([
      // Rows of past windows are swept on every hit (#489 review), as the nonce rows are: a flood of addresses leaves
      // nothing behind once its window has passed. Windows are numeric bucket labels (`rateWindowOf`).
      this.db
        .prepare(`DELETE FROM rate_limits WHERE CAST(window_start AS INTEGER) < CAST(?1 AS INTEGER) - 1`)
        .bind(window),
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

/** The fixed window of `seconds` that `at` falls in, as a bucket label (`<epoch seconds / seconds>`). */
export function rateWindowOf(at: number, seconds: number): string {
  return String(Math.floor(at / 1000 / seconds));
}
