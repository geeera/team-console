import { sprintTitleKeyOf, sprintTitleOf, type SprintState } from '@shared/contracts';
import { isConstraintError } from './constraint-error';

export interface SprintRecord {
  readonly id: number;
  readonly number: number;
  readonly title: string;
  /** YYYY-MM-DD, the demo day; `null` when none was set. */
  readonly dueOn: string | null;
  readonly state: SprintState;
  readonly description: string;
  readonly createdAt: string;
  readonly closedAt: string | null;
}

export interface NewSprint {
  readonly dueOn: string | null;
  readonly description: string;
  /** The owner's name (#457); `null` (or absent) titles it `Sprint NN`. */
  readonly title?: string | null;
  readonly at: string;
}

/** `create`'s answer: written, or nothing written because another sprint holds the number or the title (0026). */
export type SprintCreateResult = 'created' | 'number-taken' | 'title-taken';

/** `update`'s fields; an absent key leaves the column as it is. */
export interface SprintChanges {
  readonly dueOn?: string | null;
  readonly description?: string;
  readonly state?: SprintState;
}

interface SprintRow {
  id: number;
  number: number;
  title: string;
  due_on: string | null;
  state: SprintState;
  description: string;
  created_at: string;
  closed_at: string | null;
}

const COLUMNS = 'id, number, title, due_on, state, description, created_at, closed_at';

const toRecord = (row: SprintRow): SprintRecord => ({
  id: row.id,
  number: row.number,
  title: row.title,
  dueOn: row.due_on,
  state: row.state,
  description: row.description,
  createdAt: row.created_at,
  closedAt: row.closed_at,
});

/** A project's sprints (migration 0013), numbered per project like `backlog sprint create`'s `Sprint NN`. */
export class SprintsRepo {
  constructor(private readonly db: D1Database) {}

  /** In number order; `state` filters. */
  async list(slug: string, state: SprintState | 'all'): Promise<SprintRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${COLUMNS} FROM sprints WHERE project_slug = ?1 AND (?2 = 'all' OR state = ?2) ORDER BY number`,
      )
      .bind(slug, state)
      .all<SprintRow>();
    return results.map(toRecord);
  }

  async findByNumber(slug: string, number: number): Promise<SprintRecord | null> {
    const row = await this.db
      .prepare(`SELECT ${COLUMNS} FROM sprints WHERE project_slug = ?1 AND number = ?2`)
      .bind(slug, number)
      .first<SprintRow>();
    return row === null ? null : toRecord(row);
  }

  /** The sprint titled `title` ignoring case (0026's key); older repeats keep no key, so at most one matches. */
  async findByTitle(slug: string, title: string): Promise<SprintRecord | null> {
    const row = await this.db
      .prepare(`SELECT ${COLUMNS} FROM sprints WHERE project_slug = ?1 AND title_key = ?2`)
      .bind(slug, sprintTitleKeyOf(title))
      .first<SprintRow>();
    return row === null ? null : toRecord(row);
  }

  /** The number the next sprint of the project gets: one above the highest, open or closed. */
  async nextNumber(slug: string): Promise<number> {
    const row = await this.db
      .prepare('SELECT COALESCE(MAX(number), 0) + 1 AS next FROM sprints WHERE project_slug = ?1')
      .bind(slug)
      .first<{ next: number }>();
    return row?.next ?? 1;
  }

  /**
   * Sprint `number` (from `nextNumber`) titled `sprint.title` or `Sprint NN`, with `extra` in the same batch. When
   * another request took that number or that title first, the batch writes nothing and the answer says which.
   */
  async create(
    slug: string,
    number: number,
    sprint: NewSprint,
    extra: readonly D1PreparedStatement[] = [],
  ): Promise<SprintCreateResult> {
    const title = sprint.title ?? sprintTitleOf(number);
    try {
      await this.db.batch([
        this.db
          .prepare(
            `INSERT INTO sprints (project_slug, number, title, title_key, due_on, state, description, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'open', ?6, ?7)`,
          )
          .bind(slug, number, title, sprintTitleKeyOf(title), sprint.dueOn, sprint.description, sprint.at),
        ...extra,
      ]);
      return 'created';
    } catch (error: unknown) {
      if (isConstraintError(error, 'UNIQUE constraint failed: sprints.')) {
        // SQLite names only the first index that failed; a lost number race with the same default title trips the
        // title index too. The number decides, so that race stays a retryable `number-taken`.
        return (await this.findByNumber(slug, number)) === null ? 'title-taken' : 'number-taken';
      }
      throw error;
    }
  }

  /** Applies `changes`; closing sets `closed_at`, reopening clears it. The row after, or `null` for an unknown one. */
  async update(
    slug: string,
    number: number,
    changes: SprintChanges,
    at: string,
    extra: readonly D1PreparedStatement[] = [],
  ): Promise<SprintRecord | null> {
    const [updated] = await this.db.batch([
      this.db
        .prepare(
          `UPDATE sprints SET
             due_on = CASE WHEN ?3 THEN ?4 ELSE due_on END,
             description = CASE WHEN ?5 THEN ?6 ELSE description END,
             state = COALESCE(?7, state),
             closed_at = CASE WHEN ?7 = 'closed' THEN COALESCE(closed_at, ?8) WHEN ?7 = 'open' THEN NULL
                              ELSE closed_at END
           WHERE project_slug = ?1 AND number = ?2
           RETURNING ${COLUMNS}`,
        )
        .bind(
          slug,
          number,
          changes.dueOn !== undefined ? 1 : 0,
          changes.dueOn ?? null,
          changes.description !== undefined ? 1 : 0,
          changes.description ?? null,
          changes.state ?? null,
          at,
        ),
      ...extra,
    ]);
    const row = (updated?.results as SprintRow[] | undefined)?.[0];
    return row === undefined ? null : toRecord(row);
  }
}
