export type SlotRequestState = 'pending' | 'fired' | 'unknown';

/** A "Run now" request (`slot_requests`, migration 0008). */
export interface SlotRequest {
  readonly id: number;
  readonly slug: string;
  readonly slot: string;
  /** ISO 8601 UTC. */
  readonly requestedAt: string;
  readonly state: SlotRequestState;
  readonly sessionId: string | null;
}

interface SlotRequestRow {
  id: number;
  slug: string;
  slot: string;
  requested_at: string;
  state: SlotRequestState;
  session_id: string | null;
}

function toSlotRequest(row: SlotRequestRow): SlotRequest {
  return {
    id: row.id,
    slug: row.slug,
    slot: row.slot,
    requestedAt: row.requested_at,
    state: row.state,
    sessionId: row.session_id,
  };
}

/**
 * The request lock of "Run now" (#114 §4). `claim` is one statement, so two taps that arrive together cannot both
 * pass it: only one row is inserted while another request newer than `lockedAfter` exists.
 */
export class SlotRequestsRepo {
  constructor(private readonly db: D1Database) {}

  /** The newest request of the slot after `lockedAfter` (ISO 8601), or `null`. */
  async findLocking(slug: string, slot: string, lockedAfter: string): Promise<SlotRequest | null> {
    const row = await this.db
      .prepare(
        `SELECT id, slug, slot, requested_at, state, session_id FROM slot_requests
         WHERE slug = ?1 AND slot = ?2 AND requested_at > ?3
         ORDER BY requested_at DESC, id DESC LIMIT 1`,
      )
      .bind(slug, slot, lockedAfter)
      .first<SlotRequestRow>();
    return row === null ? null : toSlotRequest(row);
  }

  /**
   * Records a pending request at `requestedAt` unless a request newer than `lockedAfter` exists; returns its id, or
   * `null` when the slot is locked.
   */
  async claim(slug: string, slot: string, requestedAt: string, lockedAfter: string): Promise<number | null> {
    const row = await this.db
      .prepare(
        `INSERT INTO slot_requests (slug, slot, requested_at, state, session_id)
         SELECT ?1, ?2, ?3, 'pending', NULL
         WHERE NOT EXISTS (
           SELECT 1 FROM slot_requests WHERE slug = ?1 AND slot = ?2 AND requested_at > ?4
         )
         RETURNING id`,
      )
      .bind(slug, slot, requestedAt, lockedAfter)
      .first<{ id: number }>();
    return row === null ? null : row.id;
  }

  async settle(
    id: number,
    state: Exclude<SlotRequestState, 'pending'>,
    sessionId: string | null,
  ): Promise<void> {
    await this.db
      .prepare('UPDATE slot_requests SET state = ?2, session_id = ?3 WHERE id = ?1')
      .bind(id, state, sessionId)
      .run();
  }

  /** Nothing started (a refusal before any session): the slot is free again. */
  async release(id: number): Promise<void> {
    await this.db.prepare('DELETE FROM slot_requests WHERE id = ?1').bind(id).run();
  }

  async prune(before: string): Promise<void> {
    await this.db.prepare('DELETE FROM slot_requests WHERE requested_at < ?1').bind(before).run();
  }
}
