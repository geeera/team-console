import type { OwnerRequest, RequestKind, RequestResult } from '@shared/contracts';
import { canonicalRequest, requestOfCanonical } from '@shared/owner-grammar';
import type { TrackerActor } from './item-events.repo';

export interface ItemRequestRecord {
  readonly id: number;
  readonly itemId: number;
  readonly kind: RequestKind;
  /** `null` when the stored payload is not canonical JSON this version knows: such a row is never acted on. */
  readonly request: OwnerRequest | null;
  readonly requestedAt: string;
  readonly handledByJobId: string | null;
  readonly result: RequestResult | null;
  readonly reason: string | null;
  readonly handledAt: string | null;
}

export interface RequestHandling {
  readonly jobId: string;
  readonly result: RequestResult;
  readonly reason: string;
}

interface ItemRequestRow {
  id: number;
  item_id: number;
  kind: RequestKind;
  payload: string;
  requested_at: string;
  handled_by_job_id: string | null;
  result: RequestResult | null;
  reason: string | null;
  handled_at: string | null;
}

const COLUMNS = 'id, item_id, kind, payload, requested_at, handled_by_job_id, result, reason, handled_at';

function toRecord(row: ItemRequestRow): ItemRequestRecord {
  const request = requestOfCanonical(row.payload);
  return {
    id: row.id,
    itemId: row.item_id,
    kind: row.kind,
    request: request?.kind === row.kind ? request : null,
    requestedAt: row.requested_at,
    handledByJobId: row.handled_by_job_id,
    result: row.result,
    reason: row.reason,
    handledAt: row.handled_at,
  };
}

/**
 * The owner's requests to the PM on an item (migration 0014, `item_requests`; ADR 0005's request as a row). The
 * newest per item is the one the PM still owes. Append-only except the PM's answer, set once; `payload` is
 * `canonicalRequest`'s bytes, the same the GitHub marker carries.
 */
export class ItemRequestsRepo {
  constructor(private readonly db: D1Database) {}

  async newest(itemId: number): Promise<ItemRequestRecord | null> {
    const row = await this.db
      .prepare(`SELECT ${COLUMNS} FROM item_requests WHERE item_id = ?1 ORDER BY id DESC LIMIT 1`)
      .bind(itemId)
      .first<ItemRequestRow>();
    return row === null ? null : toRecord(row);
  }

  /** The request `id` of the project `slug`: a request of another project is not found. */
  async find(slug: string, id: number): Promise<ItemRequestRecord | null> {
    const row = await this.db
      .prepare(`SELECT ${COLUMNS} FROM item_requests WHERE project_slug = ?1 AND id = ?2`)
      .bind(slug, id)
      .first<ItemRequestRow>();
    return row === null ? null : toRecord(row);
  }

  /** Oldest first, after the request id `after` (the cursor), at most `limit`. */
  async list(itemId: number, after: number, limit: number): Promise<ItemRequestRecord[]> {
    const { results } = await this.db
      .prepare(`SELECT ${COLUMNS} FROM item_requests WHERE item_id = ?1 AND id > ?2 ORDER BY id LIMIT ?3`)
      .bind(itemId, after, limit)
      .all<ItemRequestRow>();
    return results.map(toRecord);
  }

  /** The request and its `requested` event (`{ requestId, request }`) with `extra` in one batch; the new id. */
  async create(
    slug: string,
    itemId: number,
    request: OwnerRequest,
    actor: TrackerActor,
    at: string,
    extra: readonly D1PreparedStatement[] = [],
  ): Promise<number> {
    const [inserted] = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO item_requests (project_slug, item_id, kind, payload, requested_at)
           VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id`,
        )
        .bind(slug, itemId, request.kind, canonicalRequest(request), at),
      this.db
        .prepare(
          `INSERT INTO item_events (item_id, at, actor_kind, actor, job_id, kind, before, after)
           SELECT ?1, ?2, ?3, ?4, ?5, 'requested', NULL, json_object('requestId', MAX(id), 'request', json(?6))
           FROM item_requests WHERE item_id = ?1`,
        )
        .bind(itemId, at, actor.kind, actor.name, actor.jobId, JSON.stringify(request)),
      ...extra,
    ]);
    const id = (inserted?.results as { id: number }[] | undefined)?.[0]?.id;
    if (id === undefined) {
      throw new Error('D1 returned no id for an inserted request');
    }
    return id;
  }

  /**
   * Records the PM's answer with its `handled` event (`{ requestId, result }`) and `extra`, once. `false` when the
   * request was already handled: the trigger then failed the batch, so nothing (not the event, not the key) is
   * written.
   */
  async markHandled(
    request: { readonly id: number; readonly itemId: number },
    handling: RequestHandling,
    actor: TrackerActor,
    at: string,
    extra: readonly D1PreparedStatement[] = [],
  ): Promise<boolean> {
    try {
      await this.db.batch([
        // No "not yet handled" filter: an answered request makes `item_requests_handled_once` fail the batch.
        this.db
          .prepare(
            `UPDATE item_requests SET handled_by_job_id = ?2, result = ?3, reason = ?4, handled_at = ?5
             WHERE id = ?1`,
          )
          .bind(request.id, handling.jobId, handling.result, handling.reason, at),
        this.db
          .prepare(
            `INSERT INTO item_events (item_id, at, actor_kind, actor, job_id, kind, before, after)
             VALUES (?1, ?2, ?3, ?4, ?5, 'handled', NULL, json_object('requestId', ?6, 'result', ?7))`,
          )
          .bind(request.itemId, at, actor.kind, actor.name, actor.jobId, request.id, handling.result),
        ...extra,
      ]);
      return true;
    } catch (error: unknown) {
      // Which failure it was is decided by the row, not by the driver's message: someone answered it first.
      const row = await this.db
        .prepare('SELECT handled_at FROM item_requests WHERE id = ?1')
        .bind(request.id)
        .first<{ handled_at: string | null }>();
      if (row !== null && row.handled_at !== null) {
        return false;
      }
      throw error;
    }
  }
}
