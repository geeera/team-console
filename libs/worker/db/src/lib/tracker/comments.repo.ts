import type { ActorKind, CommentKind, ItemSource } from '@shared/contracts';
import type { TrackerActor } from './item-events.repo';

export interface CommentRecord {
  readonly id: number;
  readonly itemId: number;
  readonly kind: CommentKind;
  readonly authorKind: ActorKind;
  readonly author: string;
  readonly jobId: string | null;
  readonly body: string;
  readonly createdAt: string;
  readonly source: ItemSource;
  readonly sourceUrl: string | null;
  readonly reversedByDecisionId: number | null;
}

interface CommentRow {
  id: number;
  item_id: number;
  kind: CommentKind;
  author_kind: ActorKind;
  author: string;
  job_id: string | null;
  body: string;
  created_at: string;
  source: ItemSource;
  source_url: string | null;
  reversed_by_decision_id: number | null;
}

const COLUMNS =
  'id, item_id, kind, author_kind, author, job_id, body, created_at, source, source_url, reversed_by_decision_id';

const toRecord = (row: CommentRow): CommentRecord => ({
  id: row.id,
  itemId: row.item_id,
  kind: row.kind,
  authorKind: row.author_kind,
  author: row.author,
  jobId: row.job_id,
  body: row.body,
  createdAt: row.created_at,
  source: row.source,
  sourceUrl: row.source_url,
  reversedByDecisionId: row.reversed_by_decision_id,
});

/**
 * Comments on items (migration 0013). Append-only (ADR 0006 decision 5): a correction is a new comment, so there is
 * no update or delete here, and triggers refuse both.
 */
export class CommentsRepo {
  constructor(private readonly db: D1Database) {}

  /** Oldest first, after the comment id `after` (the cursor), at most `limit`. */
  async list(itemId: number, after: number, limit: number): Promise<CommentRecord[]> {
    const { results } = await this.db
      .prepare(`SELECT ${COLUMNS} FROM comments WHERE item_id = ?1 AND id > ?2 ORDER BY id LIMIT ?3`)
      .bind(itemId, after, limit)
      .all<CommentRow>();
    return results.map(toRecord);
  }

  async find(itemId: number, id: number): Promise<CommentRecord | null> {
    const row = await this.db
      .prepare(`SELECT ${COLUMNS} FROM comments WHERE item_id = ?1 AND id = ?2`)
      .bind(itemId, id)
      .first<CommentRow>();
    return row === null ? null : toRecord(row);
  }

  /**
   * The comment, its `commented` event (naming the new comment's id) and `extra` in one batch. Returns the new
   * comment's id.
   */
  async create(
    itemId: number,
    comment: { readonly kind: CommentKind; readonly body: string },
    actor: TrackerActor,
    at: string,
    extra: readonly D1PreparedStatement[] = [],
  ): Promise<number> {
    const [inserted] = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO comments (item_id, kind, author_kind, author, job_id, body, created_at, source)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'console') RETURNING id`,
        )
        .bind(itemId, comment.kind, actor.kind, actor.name, actor.jobId, comment.body, at),
      // The batch is one transaction and D1 runs one at a time, so the newest comment on the item is this one.
      this.db
        .prepare(
          `INSERT INTO item_events (item_id, at, actor_kind, actor, job_id, kind, before, after)
           SELECT ?1, ?2, ?3, ?4, ?5, 'commented', NULL, json_object('commentId', MAX(id), 'kind', ?6)
           FROM comments WHERE item_id = ?1`,
        )
        .bind(itemId, at, actor.kind, actor.name, actor.jobId, comment.kind),
      ...extra,
    ]);
    const id = (inserted?.results as { id: number }[] | undefined)?.[0]?.id;
    if (id === undefined) {
      throw new Error('D1 returned no id for an inserted comment');
    }
    return id;
  }
}
