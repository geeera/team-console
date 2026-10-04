/** A stored browser push subscription (`push_subscriptions`, migration 0009). */
export interface PushSubscriptionRow {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly userAgent: string | null;
  /** ISO 8601 UTC. */
  readonly createdAt: string;
  readonly lastSuccessAt: string | null;
  readonly failures: number;
}

/** A subscription to store; the caller has validated the endpoint and keys. */
export interface NewPushSubscription {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly userAgent: string | null;
}

interface Row {
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  created_at: string;
  last_success_at: string | null;
  failures: number;
}

function toPushSubscription(row: Row): PushSubscriptionRow {
  return {
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    userAgent: row.user_agent,
    createdAt: row.created_at,
    lastSuccessAt: row.last_success_at,
    failures: row.failures,
  };
}

/**
 * The owner's devices (#11). Every write is one statement or one D1 batch (a transaction), so a subscribe that
 * arrives while a send prunes cannot leave more than `max` rows or resurrect a pruned one with stale keys.
 */
export class PushSubscriptionsRepo {
  constructor(private readonly db: D1Database) {}

  /** Newest first. */
  async list(): Promise<PushSubscriptionRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT endpoint, p256dh, auth, user_agent, created_at, last_success_at, failures
         FROM push_subscriptions ORDER BY created_at DESC, endpoint`,
      )
      .all<Row>();
    return results.map(toPushSubscription);
  }

  /**
   * Inserts or refreshes the subscription (new keys, failures cleared, `created_at` kept), then keeps at most `max`
   * rows by evicting the devices that have gone longest without a delivery. Returns how many were evicted.
   */
  async upsert(subscription: NewPushSubscription, now: string, max: number): Promise<number> {
    if (!Number.isInteger(max) || max < 1) {
      throw new Error(`max must be a positive integer: ${max}`);
    }
    const [, evicted] = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent, created_at, last_success_at, failures)
           VALUES (?1, ?2, ?3, ?4, ?5, NULL, 0)
           ON CONFLICT (endpoint) DO UPDATE SET
             p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent, failures = 0`,
        )
        .bind(subscription.endpoint, subscription.p256dh, subscription.auth, subscription.userAgent, now),
      this.db
        .prepare(
          `DELETE FROM push_subscriptions WHERE endpoint IN (
             SELECT endpoint FROM push_subscriptions WHERE endpoint <> ?1
             ORDER BY COALESCE(last_success_at, created_at) DESC, created_at DESC, endpoint
             LIMIT -1 OFFSET ?2
           )`,
        )
        .bind(subscription.endpoint, max - 1),
    ]);
    return evicted?.meta.changes ?? 0;
  }

  /** Returns whether a row was removed. */
  async remove(endpoint: string): Promise<boolean> {
    const result = await this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?1').bind(endpoint).run();
    return result.meta.changes > 0;
  }

  async markSuccess(endpoint: string, at: string): Promise<void> {
    await this.db
      .prepare('UPDATE push_subscriptions SET last_success_at = ?2, failures = 0 WHERE endpoint = ?1')
      .bind(endpoint, at)
      .run();
  }

  /**
   * Counts one more failure in a row and deletes the row once it reaches `pruneAt`. Returns the new count, or
   * `null` when the row is gone (pruned now, or removed meanwhile).
   */
  async markFailure(endpoint: string, pruneAt: number): Promise<number | null> {
    const [updated] = await this.db.batch<{ failures: number }>([
      this.db
        .prepare('UPDATE push_subscriptions SET failures = failures + 1 WHERE endpoint = ?1 RETURNING failures')
        .bind(endpoint),
      this.db
        .prepare('DELETE FROM push_subscriptions WHERE endpoint = ?1 AND failures >= ?2')
        .bind(endpoint, pruneAt),
    ]);
    const failures = updated?.results[0]?.failures;
    return failures === undefined || failures >= pruneAt ? null : failures;
  }
}

export type PushTestClaim = { readonly claimed: true } | { readonly claimed: false; readonly retryAfterMs: number };

/** The once-per-interval lock of "Send a test" (`push_test_sends`, migration 0009). */
export class PushTestSendsRepo {
  constructor(private readonly db: D1Database) {}

  /** Takes the lock at `nowMs` unless the last claim is younger than `intervalMs`; one statement, so two taps claim once. */
  async claim(nowMs: number, intervalMs: number): Promise<PushTestClaim> {
    const claimed = await this.db
      .prepare(
        `INSERT INTO push_test_sends (id, sent_at) VALUES (1, ?1)
         ON CONFLICT (id) DO UPDATE SET sent_at = excluded.sent_at WHERE push_test_sends.sent_at <= ?2
         RETURNING sent_at`,
      )
      .bind(nowMs, nowMs - intervalMs)
      .first<{ sent_at: number }>();
    if (claimed !== null) {
      return { claimed: true };
    }
    const last = await this.db.prepare('SELECT sent_at FROM push_test_sends WHERE id = 1').first<{ sent_at: number }>();
    const retryAfterMs = last === null ? intervalMs : Math.max(0, last.sent_at + intervalMs - nowMs);
    return { claimed: false, retryAfterMs };
  }
}
