import { isConstraintError } from './constraint-error';

export interface LabelRecord {
  readonly name: string;
  readonly color: string;
  readonly description: string;
  readonly builtin: boolean;
}

export interface NewLabel {
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

interface LabelRow {
  name: string;
  color: string;
  description: string;
  builtin: number;
}

const toRecord = (row: LabelRow): LabelRecord => ({
  name: row.name,
  color: row.color,
  description: row.description,
  builtin: row.builtin === 1,
});

/** A project's label set (migration 0013): the plugin's builtin labels and the owner's custom ones. */
export class LabelsRepo {
  constructor(private readonly db: D1Database) {}

  /** Builtin labels first, in name order. */
  async list(slug: string): Promise<LabelRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT name, color, description, builtin FROM labels WHERE project_slug = ?1
         ORDER BY builtin DESC, name`,
      )
      .bind(slug)
      .all<LabelRow>();
    return results.map(toRecord);
  }

  async find(slug: string, name: string): Promise<LabelRecord | null> {
    const row = await this.db
      .prepare('SELECT name, color, description, builtin FROM labels WHERE project_slug = ?1 AND name = ?2')
      .bind(slug, name)
      .first<LabelRow>();
    return row === null ? null : toRecord(row);
  }

  /** Which of `names` the project does not have; one query whatever the count (D1 binds ≤ 100 parameters). */
  async missing(slug: string, names: readonly string[]): Promise<string[]> {
    if (names.length === 0) {
      return [];
    }
    const { results } = await this.db
      .prepare(
        `SELECT value AS name FROM json_each(?2)
         WHERE value NOT IN (SELECT name FROM labels WHERE project_slug = ?1)`,
      )
      .bind(slug, JSON.stringify(names))
      .all<{ name: string }>();
    return results.map((row) => row.name);
  }

  /**
   * A custom label, with `extra` (the idempotency key's completion) in the same batch. `false` when the project
   * already has a label of that name, builtin or not: the batch fails as a whole, so nothing is written then.
   */
  async create(slug: string, label: NewLabel, extra: readonly D1PreparedStatement[] = []): Promise<boolean> {
    try {
      await this.db.batch([
        this.db
          .prepare(
            'INSERT INTO labels (project_slug, name, color, description, builtin) VALUES (?1, ?2, ?3, ?4, 0)',
          )
          .bind(slug, label.name, label.color, label.description),
        ...extra,
      ]);
      return true;
    } catch (error: unknown) {
      if (isConstraintError(error, 'UNIQUE constraint failed: labels.')) {
        return false;
      }
      throw error;
    }
  }
}
