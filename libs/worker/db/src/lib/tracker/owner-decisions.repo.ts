import type { DecisionCommand, DecisionVia } from '@shared/contracts';
import type { TrackerActor } from './item-events.repo';

export interface DecisionRecord {
  readonly id: number;
  readonly itemId: number;
  readonly askId: number | null;
  readonly command: DecisionCommand;
  readonly text: string;
  readonly decidedAt: string;
  readonly via: DecisionVia;
  readonly idempotencyKey: string | null;
  readonly reversesCommentId: number | null;
  readonly sourceUrl: string | null;
}

/**
 * A decision made through a route. `via` excludes `import` by type: imported decisions are history written by the
 * import writer alone (R7, Phase 1b), never by this method.
 */
export interface NewDecision {
  readonly command: DecisionCommand;
  readonly text: string;
  /** The open ask this decision answers. */
  readonly askId: number | null;
  /** The team decision (`comments.kind = 'decision'`) this decision reverses. */
  readonly reversesCommentId: number | null;
  readonly via: 'web' | 'push';
  readonly idempotencyKey: string;
}

interface DecisionRow {
  id: number;
  item_id: number;
  ask_id: number | null;
  command: DecisionCommand;
  text: string;
  decided_at: string;
  via: DecisionVia;
  idempotency_key: string | null;
  reverses_comment_id: number | null;
  source_url: string | null;
}

const COLUMNS =
  'id, item_id, ask_id, command, text, decided_at, via, idempotency_key, reverses_comment_id, source_url';

const toRecord = (row: DecisionRow): DecisionRecord => ({
  id: row.id,
  itemId: row.item_id,
  askId: row.ask_id,
  command: row.command,
  text: row.text,
  decidedAt: row.decided_at,
  via: row.via,
  idempotencyKey: row.idempotency_key,
  reversesCommentId: row.reverses_comment_id,
  sourceUrl: row.source_url,
});

// The decision this batch inserted: the batch is one transaction and D1 runs one at a time, so it is the newest on
// the item (the `CommentsRepo.create` pattern; `last_insert_rowid()` would change with every later insert).
const NEWEST_DECISION = '(SELECT MAX(id) FROM owner_decisions WHERE item_id = ?1)';

/**
 * The owner's decisions (migration 0014). Fully append-only: triggers refuse every UPDATE, DELETE and replacing
 * insert. Every route write is statements for the route's own batch, so the decision, the ask it answers, the
 * comment it reverses, the item's effects and the events land together or not at all.
 */
export class OwnerDecisionsRepo {
  constructor(private readonly db: D1Database) {}

  async find(itemId: number, id: number): Promise<DecisionRecord | null> {
    const row = await this.db
      .prepare(`SELECT ${COLUMNS} FROM owner_decisions WHERE item_id = ?1 AND id = ?2`)
      .bind(itemId, id)
      .first<DecisionRow>();
    return row === null ? null : toRecord(row);
  }

  /** Oldest first, after the decision id `after` (the cursor), at most `limit`; imported history included. */
  async list(itemId: number, after: number, limit: number): Promise<DecisionRecord[]> {
    const { results } = await this.db
      .prepare(`SELECT ${COLUMNS} FROM owner_decisions WHERE item_id = ?1 AND id > ?2 ORDER BY id LIMIT ?3`)
      .bind(itemId, after, limit)
      .all<DecisionRow>();
    return results.map(toRecord);
  }

  /**
   * The decision, the answer of its ask, the reversal of its comment, the `decided` event (`{ decisionId, command,
   * askId }`) and the `answered` event (`{ askId, decisionId }`). The ask and comment updates carry no "still open"
   * filter on purpose: an ask answered or withdrawn since it was read, or a comment already reversed, makes a
   * trigger (or a CHECK) fail the whole batch, so a decision never lands without its effects.
   */
  createStatements(
    slug: string,
    itemId: number,
    decision: NewDecision,
    actor: TrackerActor,
    at: string,
  ): D1PreparedStatement[] {
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `INSERT INTO owner_decisions (project_slug, item_id, ask_id, command, text, decided_at, via,
             idempotency_key, reverses_comment_id, source_url)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL)`,
        )
        .bind(
          slug,
          itemId,
          decision.askId,
          decision.command,
          decision.text,
          at,
          decision.via,
          decision.idempotencyKey,
          decision.reversesCommentId,
        ),
    ];
    if (decision.askId !== null) {
      statements.push(
        this.db
          .prepare(
            `UPDATE asks SET answered_by_decision_id = ${NEWEST_DECISION} WHERE id = ?2 AND item_id = ?1`,
          )
          .bind(itemId, decision.askId),
      );
    }
    if (decision.reversesCommentId !== null) {
      statements.push(
        this.db
          .prepare(
            `UPDATE comments SET reversed_by_decision_id = ${NEWEST_DECISION}
             WHERE id = ?2 AND item_id = ?1 AND kind = 'decision'`,
          )
          .bind(itemId, decision.reversesCommentId),
      );
    }
    statements.push(
      this.db
        .prepare(
          `INSERT INTO item_events (item_id, at, actor_kind, actor, job_id, kind, before, after)
           VALUES (?1, ?2, ?3, ?4, ?5, 'decided', NULL,
             json_object('decisionId', ${NEWEST_DECISION}, 'command', ?6, 'askId', ?7))`,
        )
        .bind(itemId, at, actor.kind, actor.name, actor.jobId, decision.command, decision.askId),
    );
    if (decision.askId !== null) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO item_events (item_id, at, actor_kind, actor, job_id, kind, before, after)
             VALUES (?1, ?2, ?3, ?4, ?5, 'answered', NULL,
               json_object('askId', ?6, 'decisionId', ${NEWEST_DECISION}))`,
          )
          .bind(itemId, at, actor.kind, actor.name, actor.jobId, decision.askId),
      );
    }
    return statements;
  }
}
