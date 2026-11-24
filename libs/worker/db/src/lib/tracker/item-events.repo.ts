import type { ActorKind, ItemEventKind } from '@shared/contracts';
import { isConstraintError } from './constraint-error';

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

/** How SQLite names migration 0025's index when a second link of the same pull request trips it. */
const PR_LINK_UNIQUE = "UNIQUE constraint failed: index 'item_events_pr_link'";

/**
 * What a scrub writes over a masked text; the triggers of migrations 0019 and 0043 admit exactly this replacement
 * (an event's title and body, a comment's body, an ask's text, a request's reason).
 */
export const SCRUBBED_TEXT = '[scrubbed]';

// The text an event keeps after a scrub: the same expression as the trigger's, so the trigger lets it through.
const scrubbed = (column: 'before' | 'after'): string =>
  `json_replace(${column}, '$.title', '${SCRUBBED_TEXT}', '$.body', '${SCRUBBED_TEXT}')`;
// `imported` (#477): the import's event keeps the imported text under the same two members (migration 0043).
const SCRUB_TARGET = `item_id = ?1 AND kind IN ('created', 'edited', 'imported')
  AND (before IS NOT ${scrubbed('before')} OR after IS NOT ${scrubbed('after')})`;

/**
 * What one scrub of an item masks (#477): its history (`events`) and the rows of its own the owner named. The ids are
 * recorded in the `scrubbed` event as they were asked; the statements that mask those rows come from their repos
 * (`CommentsRepo`, `AsksRepo`, `ItemRequestsRepo`) and ride in the same batch.
 */
export interface ItemScrubScope {
  readonly events: boolean;
  readonly comments: readonly number[];
  readonly asks: readonly number[];
  readonly requests: readonly number[];
}

const HISTORY_ONLY: ItemScrubScope = { events: true, comments: [], asks: [], requests: [] };

/** The tables whose rows a scrub names by id; a fixed list, so no caller value ever names a table. */
const SCRUB_ROW_TABLES = {
  comments: { table: 'comments', filter: '' },
  asks: { table: 'asks', filter: '' },
  // Only an answered request has a reason to mask.
  requests: { table: 'item_requests', filter: ' AND handled_at IS NOT NULL' },
} as const;
export type ScrubRowKind = keyof typeof SCRUB_ROW_TABLES;

/**
 * Which of `ids` are not rows of item `itemId` that a scrub can mask (#477): another item's, unknown, or a request
 * nobody answered. These rows are never deleted, so an id found here is still there for the scrub's batch.
 */
export async function scrubIdsMissing(
  db: D1Database,
  kind: ScrubRowKind,
  itemId: number,
  ids: readonly number[],
): Promise<number[]> {
  if (ids.length === 0) {
    return [];
  }
  const { table, filter } = SCRUB_ROW_TABLES[kind];
  const { results } = await db
    .prepare(
      `SELECT value AS id FROM json_each(?2)
       WHERE value NOT IN (SELECT id FROM ${table} WHERE item_id = ?1${filter}) ORDER BY value`,
    )
    .bind(itemId, JSON.stringify(ids))
    .all<{ id: number }>();
  return results.map((row) => row.id);
}

/**
 * An item's audit trail (`item_events`). Append-only: there is no delete here, and triggers refuse it and every
 * update but the owner's scrub (`scrub`, migrations 0019 and 0043).
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
   * The owner's scrub (#462, #477). With `scope.events` it masks `title` and `body` in the item's `created`, `edited`
   * and `imported` events; every other column and member is kept. It records a `scrubbed` event (`after`: how many
   * events were masked, the fields, and the ids of the comments, asks and requests the scrub named — never text),
   * with `extra` in the same batch: the statements that mask those rows, the audit row, the idempotency key. Returns
   * the count and the `scrubbed` event's id; a second scrub masks nothing and still records itself.
   */
  async scrub(
    itemId: number,
    actor: TrackerActor,
    at: string,
    extra: readonly D1PreparedStatement[] = [],
    scope: ItemScrubScope = HISTORY_ONLY,
  ): Promise<{ readonly masked: number; readonly eventId: number }> {
    const counted = scope.events
      ? await this.db
          .prepare(`SELECT COUNT(*) AS n FROM item_events WHERE ${SCRUB_TARGET}`)
          .bind(itemId)
          .first<{ n: number }>()
      : null;
    const events = counted?.n ?? 0;
    // A history-only scrub keeps #462's shape; the id lists appear only when the scrub named rows.
    const after = {
      events,
      fields: scope.events ? ['title', 'body'] : [],
      ...(scope.comments.length > 0 ? { comments: scope.comments } : {}),
      ...(scope.asks.length > 0 ? { asks: scope.asks } : {}),
      ...(scope.requests.length > 0 ? { requests: scope.requests } : {}),
    };
    await this.db.batch([
      ...(scope.events
        ? [
            this.db
              .prepare(
                `UPDATE item_events SET before = ${scrubbed('before')}, after = ${scrubbed('after')}
                 WHERE ${SCRUB_TARGET}`,
              )
              .bind(itemId),
          ]
        : []),
      itemEventStatement(this.db, { id: itemId }, actor, { kind: 'scrubbed', before: null, after }, at),
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

  /** The `pr-linked` event of a pull request link (#445), for the route's own batch. */
  prLinkStatement(
    itemId: number,
    link: { readonly number: number; readonly url: string; readonly headRef: string },
    actor: TrackerActor,
    at: string,
  ): D1PreparedStatement {
    const after = { number: link.number, url: link.url, headRef: link.headRef };
    return itemEventStatement(this.db, { id: itemId }, actor, { kind: 'pr-linked', before: null, after }, at);
  }

  /**
   * Writes the `pr-linked` event with `extra` in one batch (#529). `false` when the item already has a link of that
   * number (migration 0025's unique index: a concurrent link won), so nothing of the batch was written.
   */
  async linkPr(
    itemId: number,
    link: { readonly number: number; readonly url: string; readonly headRef: string },
    actor: TrackerActor,
    at: string,
    extra: readonly D1PreparedStatement[] = [],
  ): Promise<boolean> {
    try {
      await this.db.batch([this.prLinkStatement(itemId, link, actor, at), ...extra]);
      return true;
    } catch (error: unknown) {
      if (isConstraintError(error, PR_LINK_UNIQUE)) {
        return false;
      }
      throw error;
    }
  }

  /** The item's `pr-linked` event of pull request `number` (#445), the first if several, or `null`. */
  async findPrLink(itemId: number, number: number): Promise<ItemEventRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT id, item_id, at, actor_kind, actor, job_id, kind, before, after FROM item_events
         WHERE item_id = ?1 AND kind = 'pr-linked' AND json_extract(after, '$.number') = ?2
         ORDER BY id LIMIT 1`,
      )
      .bind(itemId, number)
      .first<ItemEventRow>();
    return row === null ? null : toRecord(row);
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
