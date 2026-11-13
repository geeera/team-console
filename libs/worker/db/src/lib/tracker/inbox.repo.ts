import { askRecordOf, type AskRecord, type AskRow } from './asks.repo';
import {
  ITEM_FROM,
  ITEM_ORDER,
  ITEM_QUEUE_COLUMNS,
  ITEM_SUMMARY_COLUMNS,
  itemRecordOf,
  type ItemRecord,
  type ItemRow,
} from './items.repo';

/** An open item the owner's inbox may list, with its open console ask. */
export interface InboxRowRecord {
  readonly item: ItemRecord;
  /** The open ask written through the console; an imported ask is never here (R7: re-confirmed, not listed). */
  readonly ask: AskRecord | null;
}

export interface InboxRows {
  readonly rows: readonly InboxRowRecord[];
  /** More open items could classify than `INBOX_ROW_CAP`; the rest are not read. */
  readonly truncated: boolean;
}

/** One project's inbox in one read; a project with more is a bigger problem than its inbox (the caller logs it). */
export const INBOX_ROW_CAP = 200;

/** The flags that can put an item in a section (`sectionOf` of `@shared/owner-grammar`); `kind:question` is the kind. */
const SECTION_FLAGS = ['team:demo', 'design:awaiting-approval', 'needs:owner', 'needs:local'] as const;

type InboxRow = ItemRow & { [K in keyof AskRow as `ask_${K}`]: AskRow[K] | null };

const ASK_COLUMNS = (
  [
    'id',
    'item_id',
    'category',
    'ask',
    'commands',
    'recommended',
    'job_id',
    'created_at',
    'source',
    'answered_by_decision_id',
    'withdrawn_at',
  ] as const
)
  .map((column) => `asks.${column} AS ask_${column}`)
  .join(', ');

function askOf(row: InboxRow): AskRecord | null {
  if (row.ask_id === null || row.ask_item_id === null || row.ask_category === null || row.ask_ask === null) {
    return null;
  }
  return askRecordOf({
    id: row.ask_id,
    item_id: row.ask_item_id,
    category: row.ask_category,
    ask: row.ask_ask,
    commands: row.ask_commands ?? '[]',
    recommended: row.ask_recommended,
    job_id: row.ask_job_id,
    created_at: row.ask_created_at ?? '',
    source: row.ask_source ?? 'console',
    answered_by_decision_id: row.ask_answered_by_decision_id,
    withdrawn_at: row.ask_withdrawn_at,
  });
}

/**
 * The Needs-you rows of a console-tracker project (#434, ADR 0006 decision 12): read-only, one query. The section
 * itself is decided by the read model over the item's full label set, as on GitHub; this query only narrows to the
 * open items that could classify.
 */
export class InboxRepo {
  constructor(private readonly db: D1Database) {}

  async listOpen(slug: string): Promise<InboxRows> {
    const flags = SECTION_FLAGS.map((_, index) => `?${String(index + 2)}`).join(', ');
    const { results } = await this.db
      .prepare(
        `SELECT ${ITEM_SUMMARY_COLUMNS}, items.body, ${ITEM_QUEUE_COLUMNS}, ${ASK_COLUMNS}
         ${ITEM_FROM}
         LEFT JOIN asks ON asks.item_id = items.id AND asks.source = 'console'
           AND asks.answered_by_decision_id IS NULL AND asks.withdrawn_at IS NULL
         WHERE items.project_slug = ?1 AND items.closed_at IS NULL
           AND (items.kind = 'question'
                OR EXISTS (SELECT 1 FROM item_labels WHERE item_id = items.id AND name IN (${flags})))
         ${ITEM_ORDER}
         LIMIT ?${String(SECTION_FLAGS.length + 2)}`,
      )
      .bind(slug, ...SECTION_FLAGS, INBOX_ROW_CAP + 1)
      .all<InboxRow>();
    return {
      rows: results.slice(0, INBOX_ROW_CAP).map((row) => ({
        item: itemRecordOf(row),
        ask: askOf(row),
      })),
      truncated: results.length > INBOX_ROW_CAP,
    };
  }
}
