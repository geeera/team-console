/** What a tracker write created or changed, so a replay can answer it again. */
export type IdempotentResultKind = 'item' | 'sprint' | 'comment' | 'label' | 'ask' | 'decision' | 'request';

export type IdempotencyClaim =
  /** This request owns the key: write, and complete the key in the write's own batch. */
  | { readonly state: 'claimed' }
  /** Another request with this key is still writing. */
  | { readonly state: 'in-flight' }
  /** The key was used for a different request (method, path or body). */
  | { readonly state: 'mismatch' }
  /** Done before: answer `status` with the resource `ref` names, write nothing. */
  | {
      readonly state: 'done';
      readonly status: number;
      readonly kind: IdempotentResultKind;
      readonly ref: string;
    };

/**
 * The resource a completed key points at: a value known before the batch, or the row the batch inserted on the item
 * (the newest comment, ask, decision or request of that item id; the batch is one transaction).
 */
export type IdempotencyRef =
  | { readonly value: string }
  | { readonly newestCommentOf: number }
  | { readonly newestAskOf: number }
  | { readonly newestDecisionOf: number }
  | { readonly newestRequestOf: number };

/** Fixed table names per ref, so no caller value ever names a table. */
function refSql(ref: IdempotencyRef): { readonly sql: string; readonly value: string | number } {
  const newest = (table: string, itemId: number) => ({
    sql: `(SELECT CAST(MAX(id) AS TEXT) FROM ${table} WHERE item_id = ?3)`,
    value: itemId,
  });
  if ('value' in ref) return { sql: '?3', value: ref.value };
  if ('newestCommentOf' in ref) return newest('comments', ref.newestCommentOf);
  if ('newestAskOf' in ref) return newest('asks', ref.newestAskOf);
  if ('newestDecisionOf' in ref) return newest('owner_decisions', ref.newestDecisionOf);
  return newest('item_requests', ref.newestRequestOf);
}

interface KeyRow {
  request_hash: string;
  status: number | null;
  result_kind: IdempotentResultKind | null;
  result_ref: string | null;
}

/** Expired keys removed per claim; enough to keep the table small without a scheduled job. */
const PRUNE_BATCH = 20;
/**
 * How long a pending claim (a write that never completed) still belongs to its own request: a different request
 * under the key cannot take it over before then, however long ago its hold ran out (ADR 0006: keys live 24 h).
 */
const PENDING_KEY_LIFETIME_MS = 24 * 60 * 60 * 1000;

/**
 * `Idempotency-Key` for tracker writes (ADR 0006: 24 h). `claim` before the write; the write's batch carries
 * `completeStatement`, so a key is complete exactly when the write's rows exist; `release` after a refusal or a
 * failed batch, so the client may try again at once.
 */
export class IdempotencyKeysRepo {
  constructor(private readonly db: D1Database) {}

  /**
   * A completed key is free again once it expired (24 h). A pending claim whose hold ran out is taken over only by
   * the same request (a retry after a crash); a different request under that key stays `mismatch`, so two writes
   * never run under one key.
   */
  async claim(key: string, requestHash: string, nowMs: number, holdMs: number): Promise<IdempotencyClaim> {
    const abandonedBefore = new Date(nowMs - PENDING_KEY_LIFETIME_MS).toISOString();
    const [, inserted] = await this.db.batch([
      this.db
        .prepare(
          `DELETE FROM idempotency_keys WHERE key IN
             (SELECT key FROM idempotency_keys WHERE expires_at <= ?1 AND key <> ?2
                AND (status IS NOT NULL OR created_at <= ?3) LIMIT ${String(PRUNE_BATCH)})`,
        )
        .bind(nowMs, key, abandonedBefore),
      this.db
        .prepare(
          `INSERT INTO idempotency_keys (key, request_hash, status, result_kind, result_ref, created_at, expires_at)
           VALUES (?1, ?2, NULL, NULL, NULL, ?3, ?4)
           ON CONFLICT (key) DO UPDATE SET request_hash = excluded.request_hash, status = NULL, result_kind = NULL,
             result_ref = NULL, created_at = excluded.created_at, expires_at = excluded.expires_at
           WHERE idempotency_keys.expires_at <= ?5
             AND (idempotency_keys.status IS NOT NULL OR idempotency_keys.request_hash = excluded.request_hash
                  OR idempotency_keys.created_at <= ?6)`,
        )
        .bind(key, requestHash, new Date(nowMs).toISOString(), nowMs + holdMs, nowMs, abandonedBefore),
    ]);
    if (inserted?.meta.changes === 1) {
      return { state: 'claimed' };
    }
    const row = await this.db
      .prepare('SELECT request_hash, status, result_kind, result_ref FROM idempotency_keys WHERE key = ?1')
      .bind(key)
      .first<KeyRow>();
    if (row === null) {
      // Released between the two statements by the request that held it: the client's retry claims it.
      return { state: 'in-flight' };
    }
    if (row.request_hash !== requestHash) {
      return { state: 'mismatch' };
    }
    if (row.status === null || row.result_kind === null || row.result_ref === null) {
      return { state: 'in-flight' };
    }
    return { state: 'done', status: row.status, kind: row.result_kind, ref: row.result_ref };
  }

  /** The statement that completes a claimed key; it belongs in the batch that writes the result. */
  completeStatement(
    key: string,
    requestHash: string,
    result: { readonly status: number; readonly kind: IdempotentResultKind; readonly ref: IdempotencyRef },
    expiresAtMs: number,
  ): D1PreparedStatement {
    const ref = refSql(result.ref);
    return this.db
      .prepare(
        `UPDATE idempotency_keys SET status = ?1, result_kind = ?2, result_ref = ${ref.sql}, expires_at = ?4
         WHERE key = ?5 AND request_hash = ?6 AND status IS NULL`,
      )
      .bind(result.status, result.kind, ref.value, expiresAtMs, key, requestHash);
  }

  /** Drops this request's pending claim; a completed key stays. */
  async release(key: string, requestHash: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM idempotency_keys WHERE key = ?1 AND request_hash = ?2 AND status IS NULL')
      .bind(key, requestHash)
      .run();
  }
}
