import type {
  ActorKind,
  ClosedReason,
  ItemKind,
  ItemSeverity,
  ItemSource,
  ItemStatus,
  ItemTier,
} from '@shared/contracts';
import { isConstraintError } from './constraint-error';
import { itemEventStatement, type NewItemEvent, type TrackerActor } from './item-events.repo';

/** An item without its body: what lists carry. */
export interface ItemSummaryRecord {
  readonly id: number;
  readonly number: number;
  readonly kind: ItemKind;
  readonly status: ItemStatus;
  readonly severity: ItemSeverity | null;
  readonly tier: ItemTier | null;
  /** The sprint's per-project number, `null` outside a sprint. */
  readonly sprintNumber: number | null;
  readonly title: string;
  /** Flag labels in name order; status, kind, severity and tier are the columns above. */
  readonly flags: readonly string[];
  readonly closedAt: string | null;
  readonly closedReason: ClosedReason | null;
  readonly createdByKind: ActorKind;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
  readonly source: ItemSource;
  readonly sourceUrl: string | null;
}

export interface ItemRecord extends ItemSummaryRecord {
  readonly body: string;
}

export interface NewItem {
  readonly number: number;
  readonly kind: ItemKind;
  readonly status: ItemStatus;
  readonly severity: ItemSeverity | null;
  readonly tier: ItemTier | null;
  /** The sprint's row id and its number in the project (the event records the number). */
  readonly sprint: { readonly id: number; readonly number: number } | null;
  readonly title: string;
  readonly body: string;
  readonly flags: readonly string[];
}

/** The columns an update sets; an absent key leaves the column as it is. */
export interface ItemColumnsPatch {
  readonly title?: string;
  readonly body?: string;
  readonly kind?: ItemKind;
  readonly status?: ItemStatus;
  readonly severity?: ItemSeverity | null;
  readonly tier?: ItemTier | null;
  readonly sprintId?: number | null;
  readonly closedAt?: string | null;
  readonly closedReason?: ClosedReason | null;
}

export interface FlagsPatch {
  readonly add: readonly string[];
  readonly remove: readonly string[];
}

export interface ItemFilter {
  readonly status?: ItemStatus;
  readonly kind?: ItemKind;
  readonly severity?: ItemSeverity;
  readonly tier?: ItemTier;
  /** A sprint number, or `none` for items outside every sprint. */
  readonly sprint?: number | 'none';
  readonly flag?: string;
  readonly state: 'open' | 'closed' | 'all';
}

export interface ItemPage {
  readonly items: readonly ItemSummaryRecord[];
  /** The cursor of the next page (the last item's number), `null` on the last page. */
  readonly next: number | null;
}

interface ItemRow {
  id: number;
  number: number;
  kind: ItemKind;
  status: ItemStatus;
  severity: ItemSeverity | null;
  tier: ItemTier | null;
  sprint_number: number | null;
  title: string;
  body?: string;
  flags: string;
  closed_at: string | null;
  closed_reason: ClosedReason | null;
  created_by_kind: ActorKind;
  created_by: string;
  created_at: string;
  updated_at: string;
  version: number;
  source: ItemSource;
  source_url: string | null;
}

const SUMMARY_COLUMNS = `items.id, items.number, items.kind, items.status, items.severity, items.tier,
  sprints.number AS sprint_number, items.title, items.closed_at, items.closed_reason, items.created_by_kind,
  items.created_by, items.created_at, items.updated_at, items.version, items.source, items.source_url,
  (SELECT json_group_array(name) FROM (SELECT name FROM item_labels WHERE item_id = items.id ORDER BY name)) AS flags`;

const FROM = 'FROM items LEFT JOIN sprints ON sprints.id = items.sprint_id';

function flagsOf(json: string): string[] {
  const parsed: unknown = JSON.parse(json);
  return Array.isArray(parsed) ? parsed.filter((name): name is string => typeof name === 'string') : [];
}

function toSummary(row: ItemRow): ItemSummaryRecord {
  return {
    id: row.id,
    number: row.number,
    kind: row.kind,
    status: row.status,
    severity: row.severity,
    tier: row.tier,
    sprintNumber: row.sprint_number,
    title: row.title,
    flags: flagsOf(row.flags),
    closedAt: row.closed_at,
    closedReason: row.closed_reason,
    createdByKind: row.created_by_kind,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
    source: row.source,
    sourceUrl: row.source_url,
  };
}

/** Column names of `ItemColumnsPatch`, fixed here so no request field ever names a column. */
const PATCH_COLUMNS: readonly (readonly [keyof ItemColumnsPatch, string])[] = [
  ['title', 'title'],
  ['body', 'body'],
  ['kind', 'kind'],
  ['status', 'status'],
  ['severity', 'severity'],
  ['tier', 'tier'],
  ['sprintId', 'sprint_id'],
  ['closedAt', 'closed_at'],
  ['closedReason', 'closed_reason'],
];

/** The marker of a stale `expectedVersion`: the update sets `version` to NULL, which NOT NULL refuses. */
const VERSION_MISMATCH = 'NOT NULL constraint failed: items.version';

/**
 * A project's items (migration 0013). Every write is one D1 batch — the item, its flag rows, its `item_events` row
 * and the caller's `extra` (the idempotency key's completion) — so a change and its audit land together or not at
 * all. Items are never deleted.
 */
export class ItemsRepo {
  constructor(private readonly db: D1Database) {}

  async findByNumber(slug: string, number: number): Promise<ItemRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT ${SUMMARY_COLUMNS}, items.body ${FROM} WHERE items.project_slug = ?1 AND items.number = ?2`,
      )
      .bind(slug, number)
      .first<ItemRow>();
    return row === null ? null : { ...toSummary(row), body: row.body ?? '' };
  }

  /** In number order after the item number `after`, at most `limit` (≤ 100, the route's bound). */
  async list(slug: string, filter: ItemFilter, after: number, limit: number): Promise<ItemPage> {
    // Each condition is a fixed fragment; only its parameter comes from the request.
    const conditions = ['items.project_slug = ?1', 'items.number > ?2'];
    const params: (string | number)[] = [slug, after];
    const add = (fragment: (n: string) => string, value: string | number): void => {
      params.push(value);
      conditions.push(fragment(`?${String(params.length)}`));
    };
    if (filter.status !== undefined) add((p) => `items.status = ${p}`, filter.status);
    if (filter.kind !== undefined) add((p) => `items.kind = ${p}`, filter.kind);
    if (filter.severity !== undefined) add((p) => `items.severity = ${p}`, filter.severity);
    if (filter.tier !== undefined) add((p) => `items.tier = ${p}`, filter.tier);
    if (filter.sprint === 'none') {
      conditions.push('items.sprint_id IS NULL');
    } else if (filter.sprint !== undefined) {
      add((p) => `sprints.number = ${p}`, filter.sprint);
    }
    if (filter.flag !== undefined) {
      add((p) => `EXISTS (SELECT 1 FROM item_labels WHERE item_id = items.id AND name = ${p})`, filter.flag);
    }
    if (filter.state === 'open') conditions.push('items.closed_at IS NULL');
    if (filter.state === 'closed') conditions.push('items.closed_at IS NOT NULL');
    params.push(limit + 1);
    const { results } = await this.db
      .prepare(
        `SELECT ${SUMMARY_COLUMNS} ${FROM} WHERE ${conditions.join(' AND ')}
         ORDER BY items.number LIMIT ?${String(params.length)}`,
      )
      .bind(...params)
      .all<ItemRow>();
    const page = results.slice(0, limit).map(toSummary);
    return { items: page, next: results.length > limit ? (page.at(-1)?.number ?? null) : null };
  }

  /**
   * Inserts the item (number from `TrackerProjectsRepo.allocateItemNumber`), its flags and its `created` event.
   * Closed from the start only as `done`. Throws on a constraint the route should have refused (an unknown flag).
   */
  async create(
    slug: string,
    item: NewItem,
    actor: TrackerActor,
    at: string,
    extra: readonly D1PreparedStatement[] = [],
  ): Promise<void> {
    const closed = item.status === 'done';
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO items (project_slug, number, kind, status, severity, tier, sprint_id, title, body, closed_at,
             closed_reason, created_by_kind, created_by, created_at, updated_at, version, source, source_url)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14, 1, 'console', NULL)`,
        )
        .bind(
          slug,
          item.number,
          item.kind,
          item.status,
          item.severity,
          item.tier,
          item.sprint?.id ?? null,
          item.title,
          item.body,
          closed ? at : null,
          closed ? 'done' : null,
          actor.kind,
          actor.name,
          at,
        ),
      ...item.flags.map((flag) =>
        this.db
          .prepare(
            `INSERT INTO item_labels (item_id, project_slug, name)
             SELECT id, project_slug, ?3 FROM items WHERE project_slug = ?1 AND number = ?2`,
          )
          .bind(slug, item.number, flag),
      ),
      itemEventStatement(
        this.db,
        { slug, number: item.number },
        actor,
        {
          kind: 'created',
          before: null,
          after: {
            kind: item.kind,
            status: item.status,
            severity: item.severity,
            tier: item.tier,
            sprint: item.sprint?.number ?? null,
            title: item.title,
            flags: [...item.flags].sort(),
          },
        },
        at,
      ),
      ...extra,
    ]);
  }

  /**
   * Applies `patch` and `flags` to item `id` if it is still at `expectedVersion`, bumping the version and writing
   * `event`. `false` on a stale version: the batch then fails as a whole and nothing is written (412 `item-version`).
   */
  async update(
    id: number,
    expectedVersion: number,
    patch: ItemColumnsPatch,
    flags: FlagsPatch,
    actor: TrackerActor,
    event: NewItemEvent,
    at: string,
    extra: readonly D1PreparedStatement[] = [],
  ): Promise<boolean> {
    const sets: string[] = [];
    const params: (string | number | null)[] = [id, expectedVersion, at];
    for (const [field, column] of PATCH_COLUMNS) {
      if (field in patch) {
        params.push(patch[field] ?? null);
        sets.push(`${column} = ?${String(params.length)}`);
      }
    }
    try {
      await this.db.batch([
        this.db
          .prepare(
            `UPDATE items SET ${[...sets, 'updated_at = ?3'].join(', ')},
               version = CASE WHEN version = ?2 THEN version + 1 ELSE NULL END
             WHERE id = ?1`,
          )
          .bind(...params),
        ...flags.remove.map((flag) =>
          this.db.prepare('DELETE FROM item_labels WHERE item_id = ?1 AND name = ?2').bind(id, flag),
        ),
        ...flags.add.map((flag) =>
          this.db
            .prepare(
              `INSERT INTO item_labels (item_id, project_slug, name)
               SELECT id, project_slug, ?2 FROM items WHERE id = ?1
               ON CONFLICT (item_id, name) DO NOTHING`,
            )
            .bind(id, flag),
        ),
        itemEventStatement(this.db, { id }, actor, event, at),
        ...extra,
      ]);
      return true;
    } catch (error: unknown) {
      if (isConstraintError(error, VERSION_MISMATCH)) {
        return false;
      }
      throw error;
    }
  }
}
