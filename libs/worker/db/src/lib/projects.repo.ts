import type { ProjectDto } from '@shared/contracts';

/** One row of `projects` (migrations 0001, 0006); column names as in SQL. */
export interface ProjectRow {
  readonly slug: string;
  readonly repo: string;
  readonly display_name: string;
  readonly routine_id: string | null;
  readonly cache_epoch: number;
  readonly added_at: string;
  readonly archived_at: string | null;
  /** The console app's installation on `repo` when the registry validated it (#15); null on legacy rows. */
  readonly installation_id: number | null;
}

/** What `create` inserts; the rest of the row has defaults. */
export interface NewProject {
  readonly slug: string;
  readonly repo: string;
  readonly displayName: string;
  readonly installationId: number;
  readonly addedAt: string;
}

/** `update`'s fields; an absent key leaves the column as it is, `routineId: null` clears it. */
export interface ProjectChanges {
  readonly displayName?: string;
  readonly routineId?: string | null;
}

/** Which existing row blocks a new one, and whether it is archived (restoring is not offered yet). */
export interface ProjectConflict {
  readonly slug: string;
  readonly archived: boolean;
}

const COLUMNS = 'slug, repo, display_name, routine_id, cache_epoch, added_at, archived_at, installation_id';

/** The project registry (ADR 0001 decision 20, #15). Every query is parameterised. */
export class ProjectsRepo {
  constructor(private readonly db: D1Database) {}

  /** Active projects in registration order; an empty list on a fresh database. */
  async listActive(): Promise<ProjectRow[]> {
    const { results } = await this.db
      .prepare(`SELECT ${COLUMNS} FROM projects WHERE archived_at IS NULL ORDER BY added_at, slug`)
      .all<ProjectRow>();
    return results;
  }

  /** Every project, archived ones after the active ones (Settings). */
  async listAll(): Promise<ProjectRow[]> {
    const { results } = await this.db
      .prepare(`SELECT ${COLUMNS} FROM projects ORDER BY archived_at IS NOT NULL, added_at, slug`)
      .all<ProjectRow>();
    return results;
  }

  /** The active project with this slug; archived and unknown slugs are both `null`. */
  async findActiveBySlug(slug: string): Promise<ProjectRow | null> {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM projects WHERE archived_at IS NULL AND slug = ?1`)
      .bind(slug)
      .first<ProjectRow>();
  }

  /** Matches `owner/name` case-insensitively: GitHub treats repository names that way and webhooks echo the stored casing. */
  async findActiveByRepo(repo: string): Promise<ProjectRow | null> {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM projects WHERE archived_at IS NULL AND lower(repo) = lower(?1)`)
      .bind(repo)
      .first<ProjectRow>();
  }

  /**
   * A row, active or archived, that already holds this slug or this repository (case-insensitively). Archived
   * rows count: slugs are secret-name suffixes and cache keys, so one is never reused for another repository.
   */
  async findConflict(slug: string, repo: string): Promise<ProjectConflict | null> {
    const row = await this.db
      .prepare('SELECT slug, archived_at FROM projects WHERE slug = ?1 OR lower(repo) = lower(?2) LIMIT 1')
      .bind(slug, repo)
      .first<{ slug: string; archived_at: string | null }>();
    return row === null ? null : { slug: row.slug, archived: row.archived_at !== null };
  }

  /**
   * Inserts the project unless a row with the slug or the repository exists — one statement, so two concurrent
   * adds cannot both pass a separate check. `false` when nothing was inserted.
   */
  async create(project: NewProject): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO projects (slug, repo, display_name, installation_id, added_at)
         SELECT ?1, ?2, ?3, ?4, ?5
         WHERE NOT EXISTS (SELECT 1 FROM projects WHERE slug = ?1 OR lower(repo) = lower(?2))`,
      )
      .bind(project.slug, project.repo, project.displayName, project.installationId, project.addedAt)
      .run();
    return result.meta.changes === 1;
  }

  /** Applies the changes to an active project; `null` when there is none with this slug. */
  async update(slug: string, changes: ProjectChanges): Promise<ProjectRow | null> {
    const hasDisplayName = changes.displayName !== undefined;
    const hasRoutineId = changes.routineId !== undefined;
    return this.db
      .prepare(
        `UPDATE projects
         SET display_name = CASE WHEN ?2 THEN ?3 ELSE display_name END,
             routine_id = CASE WHEN ?4 THEN ?5 ELSE routine_id END
         WHERE slug = ?1 AND archived_at IS NULL
         RETURNING ${COLUMNS}`,
      )
      .bind(
        slug,
        hasDisplayName ? 1 : 0,
        changes.displayName ?? null,
        hasRoutineId ? 1 : 0,
        changes.routineId ?? null,
      )
      .first<ProjectRow>();
  }

  /** Sets `archived_at` on an active project; `false` when there is none with this slug. */
  async archive(slug: string, archivedAt: string): Promise<boolean> {
    const result = await this.db
      .prepare('UPDATE projects SET archived_at = ?2 WHERE slug = ?1 AND archived_at IS NULL')
      .bind(slug, archivedAt)
      .run();
    return result.meta.changes === 1;
  }
}

export function toProjectDto(row: ProjectRow): ProjectDto {
  return {
    slug: row.slug,
    repo: row.repo,
    displayName: row.display_name,
    routineId: row.routine_id,
    addedAt: row.added_at,
    archivedAt: row.archived_at,
  };
}
