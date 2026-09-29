import type { ProjectDto } from '@shared/contracts';

/** One row of `projects` (migration 0001); column names as in SQL. */
export interface ProjectRow {
  readonly slug: string;
  readonly repo: string;
  readonly display_name: string;
  readonly routine_id: string | null;
  readonly cache_epoch: number;
  readonly added_at: string;
  readonly archived_at: string | null;
}

const COLUMNS = 'slug, repo, display_name, routine_id, cache_epoch, added_at, archived_at';

/** Read access to the project registry (ADR 0001, decision 20). Writes arrive with the Settings screen (#15). */
export class ProjectsRepo {
  constructor(private readonly db: D1Database) {}

  /** Active projects in registration order; an empty list on a fresh database. */
  async listActive(): Promise<ProjectRow[]> {
    const { results } = await this.db
      .prepare(`SELECT ${COLUMNS} FROM projects WHERE archived_at IS NULL ORDER BY added_at, slug`)
      .all<ProjectRow>();
    return results;
  }

  /** Matches `owner/name` case-insensitively: GitHub treats repository names that way and webhooks echo the stored casing. */
  async findActiveByRepo(repo: string): Promise<ProjectRow | null> {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM projects WHERE archived_at IS NULL AND lower(repo) = lower(?1)`)
      .bind(repo)
      .first<ProjectRow>();
  }
}

export function toProjectDto(row: ProjectRow): ProjectDto {
  return {
    slug: row.slug,
    repo: row.repo,
    displayName: row.display_name,
    addedAt: row.added_at,
  };
}
