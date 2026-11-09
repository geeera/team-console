import type { ActorKind, ItemEventKind } from '@shared/contracts';

/** Who made a tracker change; derived by the server from the identity, never taken from a request body. */
export interface TrackerActor {
  readonly kind: ActorKind;
  /** Display only: `owner`, a role name or an imported login. */
  readonly name: string;
  readonly jobId: string | null;
}

/** The changed fields only, before and after (ADR 0006 decision 5); `null` where a side has none (`created`). */
export interface NewItemEvent {
  readonly kind: ItemEventKind;
  readonly before: Readonly<Record<string, unknown>> | null;
  readonly after: Readonly<Record<string, unknown>> | null;
}

export interface ItemEventRecord {
  readonly id: number;
  readonly itemId: number;
  readonly at: string;
  readonly actorKind: ActorKind;
  readonly actor: string;
  readonly jobId: string | null;
  readonly kind: ItemEventKind;
  readonly before: unknown;
  readonly after: unknown;
}

interface ItemEventRow {
  id: number;
  item_id: number;
  at: string;
  actor_kind: ActorKind;
  actor: string;
  job_id: string | null;
  kind: ItemEventKind;
  before: string | null;
  after: string | null;
}

function toRecord(row: ItemEventRow): ItemEventRecord {
  return {
    id: row.id,
    itemId: row.item_id,
    at: row.at,
    actorKind: row.actor_kind,
    actor: row.actor,
    jobId: row.job_id,
    kind: row.kind,
    // The column is CHECKed with json_valid, so a parse failure is a broken database, not input.
    before: row.before === null ? null : (JSON.parse(row.before) as unknown),
    after: row.after === null ? null : (JSON.parse(row.after) as unknown),
  };
}

/**
 * The event row of a write, for the write's own batch, so it lands in the same transaction as the change it
 * describes. `item` is the row id, or the project and number of an item inserted earlier in that batch.
 */
export function itemEventStatement(
  db: D1Database,
  item: { readonly id: number } | { readonly slug: string; readonly number: number },
  actor: TrackerActor,
  event: NewItemEvent,
  at: string,
): D1PreparedStatement {
  const before = event.before === null ? null : JSON.stringify(event.before);
  const after = event.after === null ? null : JSON.stringify(event.after);
  if ('id' in item) {
    return db
      .prepare(
        `INSERT INTO item_events (item_id, at, actor_kind, actor, job_id, kind, before, after)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      )
      .bind(item.id, at, actor.kind, actor.name, actor.jobId, event.kind, before, after);
  }
  return db
    .prepare(
      `INSERT INTO item_events (item_id, at, actor_kind, actor, job_id, kind, before, after)
       SELECT id, ?3, ?4, ?5, ?6, ?7, ?8, ?9 FROM items WHERE project_slug = ?1 AND number = ?2`,
    )
    .bind(item.slug, item.number, at, actor.kind, actor.name, actor.jobId, event.kind, before, after);
}

/** What a scrub writes over a title or a body; migration 0019's trigger admits exactly this replacement. */
export const SCRUBBED_TEXT = '[scrubbed]';

// The text an event keeps after a scrub: the same expression as the trigger's, so the trigger lets it through.
const scrubbed = (column: 'before' | 'after'): string =>
  `json_replace(${column}, '$.title', '${SCRUBBED_TEXT}', '$.body', '${SCRUBBED_TEXT}')`;
const SCRUB_TARGET = `item_id = ?1 AND kind IN ('created', 'edited')
  AND (before IS NOT ${scrubbed('before')} OR after IS NOT ${scrubbed('after')})`;

/**
 * An item's audit trail (`item_events`). Append-only: there is no delete here, and triggers refuse it and every
 * update but the owner's scrub (`scrub`, migration 0019).
 */
export class ItemEventsRepo {
  constructor(private readonly db: D1Database) {}

  /** One event of item `itemId`, or `null`. */
  async find(itemId: number, id: number): Promise<ItemEventRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT id, item_id, at, actor_kind, actor, job_id, kind, before, after FROM item_events
         WHERE item_id = ?1 AND id = ?2`,
      )
      .bind(itemId, id)
      .first<ItemEventRow>();
    return row === null ? null : toRecord(row);
  }

  /**
   * The owner's scrub (#462): masks `title` and `body` in the item's `created` and `edited` events and records a
   * `scrubbed` event (`after.events`: how many events were masked), with `extra` in the same batch. Every other
   * column and member is kept. Returns that count and the `scrubbed` event's id; a second scrub masks nothing and
   * still records itself.
   */
  async scrub(
    itemId: number,
    actor: TrackerActor,
    at: string,
    extra: readonly D1PreparedStatement[] = [],
  ): Promise<{ readonly masked: number; readonly eventId: number }> {
    const counted = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM item_events WHERE ${SCRUB_TARGET}`)
      .bind(itemId)
      .first<{ n: number }>();
    const events = counted?.n ?? 0;
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE item_events SET before = ${scrubbed('before')}, after = ${scrubbed('after')}
           WHERE ${SCRUB_TARGET}`,
        )
        .bind(itemId),
      itemEventStatement(
        this.db,
        { id: itemId },
        actor,
        { kind: 'scrubbed', before: null, after: { events, fields: ['title', 'body'] } },
        at,
      ),
      ...extra,
    ]);
    const recorded = await this.db
      .prepare(`SELECT MAX(id) AS id FROM item_events WHERE item_id = ?1 AND kind = 'scrubbed'`)
      .bind(itemId)
      .first<{ id: number | null }>();
    if (recorded?.id === null || recorded?.id === undefined) {
      throw new Error('the scrub batch committed without its scrubbed event');
    }
    return { masked: events, eventId: recorded.id };
  }

  /** Oldest first, after the event id `after` (the cursor), at most `limit`. */
  async list(itemId: number, after: number, limit: number): Promise<ItemEventRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, item_id, at, actor_kind, actor, job_id, kind, before, after FROM item_events
         WHERE item_id = ?1 AND id > ?2 ORDER BY id LIMIT ?3`,
      )
      .bind(itemId, after, limit)
      .all<ItemEventRow>();
    return results.map(toRecord);
  }
}
