import type { TrackerMode } from '@shared/contracts';
import { LABELS_SEED } from './labels-seed';

/** A project's tracker columns (migration 0013). */
export interface TrackerProject {
  readonly slug: string;
  readonly tracker: TrackerMode;
  /** Set whenever `tracker` is not `github` (a CHECK constraint). */
  readonly keyPrefix: string | null;
  readonly nextItemNumber: number;
  readonly cutoverAt: string | null;
}

export interface TrackerSwitch {
  readonly tracker: Exclude<TrackerMode, 'github'>;
  readonly keyPrefix: string;
  /** The first number a new item gets; never lowers the current one. The import sets max(issue, PR number) + 1. */
  readonly nextItemNumber: number;
  /** ISO 8601 UTC; becomes `cutover_at` when the tracker is `console`. */
  readonly at: string;
}

interface TrackerRow {
  slug: string;
  tracker: TrackerMode;
  key_prefix: string | null;
  next_item_number: number;
  cutover_at: string | null;
}

function trackerProjectOf(row: TrackerRow): TrackerProject {
  return {
    slug: row.slug,
    tracker: row.tracker,
    keyPrefix: row.key_prefix,
    nextItemNumber: row.next_item_number,
    cutoverAt: row.cutover_at,
  };
}

/** The tracker side of the project registry (ADR 0006 decisions 1-2). Every query is parameterised. */
export class TrackerProjectsRepo {
  constructor(private readonly db: D1Database) {}

  /** The active project's tracker columns; archived and unknown slugs are both `null`. */
  async find(slug: string): Promise<TrackerProject | null> {
    const row = await this.db
      .prepare(
        `SELECT slug, tracker, key_prefix, next_item_number, cutover_at FROM projects
         WHERE slug = ?1 AND archived_at IS NULL`,
      )
      .bind(slug)
      .first<TrackerRow>();
    return row === null ? null : trackerProjectOf(row);
  }

  /** Every active project's tracker columns in one read, by slug (Needs you branches on them, #434). */
  async listActive(): Promise<ReadonlyMap<string, TrackerProject>> {
    const { results } = await this.db
      .prepare(
        `SELECT slug, tracker, key_prefix, next_item_number, cutover_at FROM projects WHERE archived_at IS NULL`,
      )
      .all<TrackerRow>();
    return new Map(results.map((row) => [row.slug, trackerProjectOf(row)]));
  }

  /**
   * Takes the project's next item number in one statement, so two creates never share one. `null` when the project
   * is unknown, archived or still on GitHub Issues: the tracker gate holds here too, not only in the route.
   */
  async allocateItemNumber(slug: string): Promise<number | null> {
    const row = await this.db
      .prepare(
        `UPDATE projects SET next_item_number = next_item_number + 1
         WHERE slug = ?1 AND archived_at IS NULL AND tracker <> 'github'
         RETURNING next_item_number - 1 AS number`,
      )
      .bind(slug)
      .first<{ number: number }>();
    return row?.number ?? null;
  }

  /**
   * Moves a project off GitHub Issues and seeds its builtin labels in the same batch (existing labels are kept). The
   * cutover (Phase 1b) is its caller; no route reaches it in Phase 1a. `false` for an unknown or archived project.
   */
  async switchTracker(slug: string, change: TrackerSwitch): Promise<boolean> {
    const [updated] = await this.db.batch([
      this.db
        .prepare(
          `UPDATE projects SET tracker = ?2, key_prefix = ?3, next_item_number = MAX(next_item_number, ?4),
             cutover_at = CASE WHEN ?2 = 'console' THEN COALESCE(cutover_at, ?5) ELSE cutover_at END
           WHERE slug = ?1 AND archived_at IS NULL`,
        )
        .bind(slug, change.tracker, change.keyPrefix, change.nextItemNumber, change.at),
      ...LABELS_SEED.map((label) =>
        this.db
          .prepare(
            `INSERT INTO labels (project_slug, name, color, description, builtin)
             SELECT slug, ?2, ?3, ?4, 1 FROM projects WHERE slug = ?1 AND archived_at IS NULL
             ON CONFLICT (project_slug, name) DO NOTHING`,
          )
          .bind(slug, label.name, label.color, label.description),
      ),
    ]);
    return updated?.meta.changes === 1;
  }
}
