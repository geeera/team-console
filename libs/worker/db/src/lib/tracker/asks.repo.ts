import { isAskCommand, type AskCategory, type AskCommand, type ItemSource } from '@shared/contracts';
import type { TrackerActor } from './item-events.repo';

export interface AskRecord {
  readonly id: number;
  readonly itemId: number;
  readonly category: AskCategory;
  readonly ask: string;
  readonly commands: readonly AskCommand[];
  readonly recommended: AskCommand | null;
  readonly jobId: string | null;
  readonly createdAt: string;
  readonly source: ItemSource;
  readonly answeredByDecisionId: number | null;
  readonly withdrawnAt: string | null;
}

export interface NewAsk {
  readonly category: AskCategory;
  readonly ask: string;
  readonly commands: readonly AskCommand[];
  readonly recommended: AskCommand | null;
}

/** A row of `asks`; shared with the read-only inbox query. */
export interface AskRow {
  id: number;
  item_id: number;
  category: AskCategory;
  ask: string;
  commands: string;
  recommended: string | null;
  job_id: string | null;
  created_at: string;
  source: ItemSource;
  answered_by_decision_id: number | null;
  withdrawn_at: string | null;
}

const COLUMNS =
  'id, item_id, category, ask, commands, recommended, job_id, created_at, source, answered_by_decision_id, withdrawn_at';

/** Only answer commands survive the read; the trigger already refuses anything else on insert. */
function commandsOf(json: string): AskCommand[] {
  const parsed: unknown = JSON.parse(json);
  return Array.isArray(parsed) ? parsed.filter(isAskCommand) : [];
}

export function askRecordOf(row: AskRow): AskRecord {
  const commands = commandsOf(row.commands);
  return {
    id: row.id,
    itemId: row.item_id,
    category: row.category,
    ask: row.ask,
    commands,
    // Fails closed: a recommendation that is not one of the commands is no recommendation.
    recommended: isAskCommand(row.recommended) && commands.includes(row.recommended) ? row.recommended : null,
    jobId: row.job_id,
    createdAt: row.created_at,
    source: row.source,
    answeredByDecisionId: row.answered_by_decision_id,
    withdrawnAt: row.withdrawn_at,
  };
}

/**
 * Questions to the owner (migration 0014, formerly `pt-ask`). Append-only: an ask is answered by a decision or
 * withdrawn by the next ask, each once, and triggers refuse every other change. The writes are statements for the
 * route's own batch, so the ask, its `asked` event, the item's `owner:*` flag and the idempotency key land together.
 */
export class AsksRepo {
  constructor(private readonly db: D1Database) {}

  /** The item's open ask (at most one, by the partial unique index), whatever its source. */
  async findOpen(itemId: number): Promise<AskRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT ${COLUMNS} FROM asks
         WHERE item_id = ?1 AND answered_by_decision_id IS NULL AND withdrawn_at IS NULL`,
      )
      .bind(itemId)
      .first<AskRow>();
    return row === null ? null : askRecordOf(row);
  }

  async find(itemId: number, id: number): Promise<AskRecord | null> {
    const row = await this.db
      .prepare(`SELECT ${COLUMNS} FROM asks WHERE item_id = ?1 AND id = ?2`)
      .bind(itemId, id)
      .first<AskRow>();
    return row === null ? null : askRecordOf(row);
  }

  /** Oldest first, after the ask id `after` (the cursor), at most `limit`. */
  async list(itemId: number, after: number, limit: number): Promise<AskRecord[]> {
    const { results } = await this.db
      .prepare(`SELECT ${COLUMNS} FROM asks WHERE item_id = ?1 AND id > ?2 ORDER BY id LIMIT ?3`)
      .bind(itemId, after, limit)
      .all<AskRow>();
    return results.map(askRecordOf);
  }

  /**
   * The open ask `id` withdrawn at `at`. Without an "is still open" filter on purpose: an ask answered or withdrawn
   * since it was read makes the trigger (or the CHECK) fail the whole batch instead of writing a second open ask.
   */
  withdrawStatement(id: number, at: string): D1PreparedStatement {
    return this.db.prepare('UPDATE asks SET withdrawn_at = ?2 WHERE id = ?1').bind(id, at);
  }

  /**
   * The new ask and its `asked` event (`{ askId, replacedAskId, category }`). The batch is one transaction and D1
   * runs one at a time, so the newest ask on the item is this one.
   */
  createStatements(
    slug: string,
    itemId: number,
    ask: NewAsk,
    actor: TrackerActor,
    at: string,
    replacedAskId: number | null,
  ): D1PreparedStatement[] {
    return [
      this.db
        .prepare(
          `INSERT INTO asks (project_slug, item_id, category, ask, commands, recommended, job_id, created_at, source)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'console')`,
        )
        .bind(
          slug,
          itemId,
          ask.category,
          ask.ask,
          JSON.stringify(ask.commands),
          ask.recommended,
          actor.jobId,
          at,
        ),
      this.db
        .prepare(
          `INSERT INTO item_events (item_id, at, actor_kind, actor, job_id, kind, before, after)
           SELECT ?1, ?2, ?3, ?4, ?5, 'asked', NULL,
             json_object('askId', MAX(id), 'replacedAskId', ?6, 'category', ?7)
           FROM asks WHERE item_id = ?1`,
        )
        .bind(itemId, at, actor.kind, actor.name, actor.jobId, replacedAskId, ask.category),
    ];
  }
}
