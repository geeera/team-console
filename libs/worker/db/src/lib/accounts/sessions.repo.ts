/** One live `sessions` row (migration 0018) as the auth seam reads it: who it belongs to, nothing more. */
export interface SessionRecord {
  readonly idHash: string;
  readonly userId: string;
  readonly expiresAt: string;
}

const HEX_64 = /^[0-9a-f]{64}$/;

/** SHA-256 hex of the opaque session id the cookie carries; D1 never holds the id itself (ADR 0008 decision 3). */
export async function sessionIdHashOf(sessionId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sessionId));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The console's own sessions (decision 3). T-3 creates and revokes them; T-2 resolves the member actor from one
 * (#466). A session answers only while unrevoked and before its expiry, compared as the ISO UTC text the table CHECKs.
 */
export class SessionsRepo {
  constructor(private readonly db: D1Database) {}

  async findActive(idHash: string, now: string): Promise<SessionRecord | null> {
    if (!HEX_64.test(idHash)) {
      return null;
    }
    const row = await this.db
      .prepare(
        `SELECT id_hash, user_id, expires_at FROM sessions
         WHERE id_hash = ?1 AND revoked_at IS NULL AND expires_at > ?2`,
      )
      .bind(idHash, now)
      .first<{ id_hash: string; user_id: string; expires_at: string }>();
    return row === null ? null : { idHash: row.id_hash, userId: row.user_id, expiresAt: row.expires_at };
  }

  /** Moves `last_seen_at` forward; the idle window is the caller's rule (T-3), this only records the visit. */
  async touch(idHash: string, now: string): Promise<void> {
    await this.db
      .prepare('UPDATE sessions SET last_seen_at = ?2 WHERE id_hash = ?1 AND revoked_at IS NULL')
      .bind(idHash, now)
      .run();
  }
}
