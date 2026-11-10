import { NOT_SNOOZED, type ProjectDto, type SnoozeDto, type TrackerMode } from '@shared/contracts';
import { isConstraintError } from './tracker/constraint-error';

/** One row of `projects` (migrations 0001, 0006, 0011, 0013, 0018); column names as in SQL. */
export interface ProjectRow {
  readonly slug: string;
  readonly repo: string;
  /** The account that owns the project (0018, ADR 0008 decision 1); every read of the row is scoped by it. */
  readonly account_id: string;
  /** The provider's repository id (0018, decision 2: webhooks match by it); `null` until backfilled. */
  readonly repo_id: number | null;
  readonly provider: 'github' | 'gitlab';
  /** The tracker columns of 0013, so one scoped read serves the registry and the tracker alike. */
  readonly tracker: TrackerMode;
  readonly key_prefix: string | null;
  readonly next_item_number: number;
  readonly cutover_at: string | null;
  readonly display_name: string;
  readonly routine_id: string | null;
  readonly cache_epoch: number;
  readonly added_at: string;
  readonly archived_at: string | null;
  /** The console app's installation on `repo` when the registry validated it (#15); null on legacy rows. */
  readonly installation_id: number | null;
  /** When the owner snoozed the project's notifications (#221); `null` while not snoozed. */
  readonly snoozed_at: string | null;
  /** The end of the snooze; `null` while `snoozed_at` is set = until turned back on. */
  readonly snoozed_until: string | null;
  /** 1: urgent pushes still arrive while snoozed (the default); 0: they are muted too. */
  readonly snooze_allows_urgent: number;
}

/** `setSnooze`'s fields; `until` is ISO 8601 UTC, already validated by the route. */
export interface SnoozeChange {
  readonly until: string | null;
  readonly allowsUrgent: boolean;
}

/** What `create` inserts; the rest of the row has defaults. */
export interface NewProject {
  readonly slug: string;
  readonly repo: string;
  readonly displayName: string;
  readonly installationId: number;
  readonly addedAt: string;
  /** The admitted account (ADR 0008 decision 2): from the request's scope, never from a body. */
  readonly accountId: string;
  /** The provider's repository id as the API reported it at creation (decision 4); `null` only for legacy callers. */
  readonly repoId: number | null;
}

/**
 * `created`, or which UNIQUE the row collided with: the slug (another account may hold it, decision 1's accepted
 * oracle) or the repository (by name or by id). A lost race and the pre-check answer the same.
 */
export type CreateProjectResult = 'created' | 'slug-taken' | 'repo-taken';

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

const COLUMNS =
  'slug, repo, account_id, repo_id, provider, tracker, key_prefix, next_item_number, cutover_at, display_name, ' +
  'routine_id, cache_epoch, added_at, archived_at, installation_id, snoozed_at, snoozed_until, snooze_allows_urgent';

/**
 * A repository as a webhook names it: by the provider's id when the row has one recorded (ADR 0008 decision 2), by
 * name only for a row registered before 0018 whose id is not backfilled yet.
 */
export interface RepositoryMatch {
  readonly id: number | null;
  readonly fullName: string;
}

/** `?1` the id, `?2` the name. */
const REPOSITORY_MATCH =
  '((?1 IS NOT NULL AND repo_id = ?1) OR (repo_id IS NULL AND lower(repo) = lower(?2)))';

/** `WHERE account_id IN (…)` over a bound list; an empty scope matches nothing, so no row ever leaks by default. */
function accountFilter(accountIds: readonly string[]): { readonly sql: string; readonly binds: string[] } {
  if (accountIds.length === 0) {
    return { sql: '0', binds: [] };
  }
  return {
    sql: `account_id IN (${accountIds.map((_, index) => `?${String(index + 1)}`).join(', ')})`,
    binds: [...accountIds],
  };
}

/** The project registry (ADR 0001 decision 20, #15). Every query is parameterised. */
export class ProjectsRepo {
  constructor(private readonly db: D1Database) {}

  /**
   * The active projects of these accounts in registration order (ADR 0008 decision 2: a list is always the scope's,
   * never the environment's); an empty scope lists nothing.
   */
  async listActive(accountIds: readonly string[]): Promise<ProjectRow[]> {
    const filter = accountFilter(accountIds);
    const { results } = await this.db
      .prepare(
        `SELECT ${COLUMNS} FROM projects WHERE archived_at IS NULL AND ${filter.sql} ORDER BY added_at, slug`,
      )
      .bind(...filter.binds)
      .all<ProjectRow>();
    return results;
  }

  /** Every project of these accounts, archived ones after the active ones (Settings). */
  async listAll(accountIds: readonly string[]): Promise<ProjectRow[]> {
    const filter = accountFilter(accountIds);
    const { results } = await this.db
      .prepare(
        `SELECT ${COLUMNS} FROM projects WHERE ${filter.sql} ORDER BY archived_at IS NOT NULL, added_at, slug`,
      )
      .bind(...filter.binds)
      .all<ProjectRow>();
    return results;
  }

  /**
   * The active project with this slug, whatever its account; archived and unknown slugs are both `null`. The scope
   * check is the caller's (`projects/lookup.ts` in the api Worker), which answers the same 404 for both.
   */
  async findActiveBySlug(slug: string): Promise<ProjectRow | null> {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM projects WHERE archived_at IS NULL AND slug = ?1`)
      .bind(slug)
      .first<ProjectRow>();
  }

  /** The active project of the provider's repository id (decision 2: a rename or transfer never lands elsewhere). */
  async findActiveByRepoId(provider: 'github' | 'gitlab', repoId: number): Promise<ProjectRow | null> {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM projects WHERE archived_at IS NULL AND provider = ?1 AND repo_id = ?2`)
      .bind(provider, repoId)
      .first<ProjectRow>();
  }

  /**
   * Records the repository id once (the 0018 trigger refuses a change); `false` when the row already has one or
   * another project holds this id. The backfill of rows registered before 0018 (T-2).
   */
  async setRepoId(slug: string, repoId: number): Promise<boolean> {
    try {
      const result = await this.db
        .prepare('UPDATE projects SET repo_id = ?2 WHERE slug = ?1 AND repo_id IS NULL')
        .bind(slug, repoId)
        .run();
      return result.meta.changes === 1;
    } catch (error: unknown) {
      if (isConstraintError(error, 'UNIQUE constraint failed: projects.provider, projects.repo_id')) {
        return false;
      }
      throw error;
    }
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
   * adds cannot both pass a separate check. A race the statement's own check misses (the exact-case repository,
   * the repository id) trips 0018's `projects_never_replaced` trigger instead; both answer which UNIQUE was taken,
   * never a 500 (#472 review).
   */
  async create(project: NewProject): Promise<CreateProjectResult> {
    let inserted: boolean;
    try {
      const result = await this.db
        .prepare(
          `INSERT INTO projects (slug, repo, display_name, installation_id, added_at, account_id, repo_id)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
           WHERE NOT EXISTS (
             SELECT 1 FROM projects
             WHERE slug = ?1 OR lower(repo) = lower(?2) OR (?7 IS NOT NULL AND provider = 'github' AND repo_id = ?7)
           )`,
        )
        .bind(
          project.slug,
          project.repo,
          project.displayName,
          project.installationId,
          project.addedAt,
          project.accountId,
          project.repoId,
        )
        .run();
      inserted = result.meta.changes === 1;
    } catch (error: unknown) {
      if (!isConstraintError(error, 'projects are never replaced')) {
        throw error;
      }
      inserted = false;
    }
    if (inserted) {
      return 'created';
    }
    const conflict = await this.findConflict(project.slug, project.repo);
    return conflict?.slug === project.slug ? 'slug-taken' : 'repo-taken';
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

  /**
   * Invalidates every cached read of the project (`readCacheKey` carries the epoch). Called by the hooks Worker;
   * the column is the only cross-Worker cache signal (no Worker-to-Worker call, #9/#12).
   */
  async bumpCacheEpoch(slug: string): Promise<void> {
    await this.db
      .prepare('UPDATE projects SET cache_epoch = cache_epoch + 1 WHERE slug = ?1')
      .bind(slug)
      .run();
  }

  /**
   * Marks the active project of this repository and installation **in the installation's account** as unreachable
   * by the app (migration 0010; ADR 0008 decision 2: an installation event touches its own account's rows only),
   * unless it already is; the rows that changed, so the caller tells the owner once.
   */
  async markAccessLost(
    repo: RepositoryMatch,
    installationId: number,
    accountId: string,
    lostAt: string,
  ): Promise<ProjectRow[]> {
    const { results } = await this.db
      .prepare(
        `UPDATE projects SET access_lost_at = ?5
         WHERE archived_at IS NULL AND access_lost_at IS NULL AND ${REPOSITORY_MATCH}
           AND installation_id = ?3 AND account_id = ?4
         RETURNING ${COLUMNS}`,
      )
      .bind(repo.id, repo.fullName, installationId, accountId, lostAt)
      .all<ProjectRow>();
    return results;
  }

  /** `markAccessLost` for every active project of an installation in its account (the app was uninstalled). */
  async markInstallationLost(
    installationId: number,
    accountId: string,
    lostAt: string,
  ): Promise<ProjectRow[]> {
    const { results } = await this.db
      .prepare(
        `UPDATE projects SET access_lost_at = ?3
         WHERE archived_at IS NULL AND access_lost_at IS NULL AND installation_id = ?1 AND account_id = ?2
         RETURNING ${COLUMNS}`,
      )
      .bind(installationId, accountId, lostAt)
      .all<ProjectRow>();
    return results;
  }

  /** Clears `access_lost_at` once the repository is back in the same installation and account; the rows that changed. */
  async clearAccessLost(
    repo: RepositoryMatch,
    installationId: number,
    accountId: string,
  ): Promise<ProjectRow[]> {
    const { results } = await this.db
      .prepare(
        `UPDATE projects SET access_lost_at = NULL
         WHERE archived_at IS NULL AND access_lost_at IS NOT NULL AND ${REPOSITORY_MATCH}
           AND installation_id = ?3 AND account_id = ?4
         RETURNING ${COLUMNS}`,
      )
      .bind(repo.id, repo.fullName, installationId, accountId)
      .all<ProjectRow>();
    return results;
  }

  /**
   * Snoozes an active project's notifications from `now` (#221), replacing any snooze it had; the row as it is now,
   * or `null` when there is no active project with this slug.
   */
  async setSnooze(slug: string, change: SnoozeChange, now: string): Promise<ProjectRow | null> {
    return this.db
      .prepare(
        `UPDATE projects SET snoozed_at = ?2, snoozed_until = ?3, snooze_allows_urgent = ?4
         WHERE slug = ?1 AND archived_at IS NULL
         RETURNING ${COLUMNS}`,
      )
      .bind(slug, now, change.until, change.allowsUrgent ? 1 : 0)
      .first<ProjectRow>();
  }

  /** Turns an active project's notifications back on; idempotent. `null` when there is no such project. */
  async clearSnooze(slug: string): Promise<ProjectRow | null> {
    return this.db
      .prepare(
        `UPDATE projects SET snoozed_at = NULL, snoozed_until = NULL, snooze_allows_urgent = 1
         WHERE slug = ?1 AND archived_at IS NULL
         RETURNING ${COLUMNS}`,
      )
      .bind(slug)
      .first<ProjectRow>();
  }

  /**
   * Sets `archived_at` on an active project, with `extra` statements (its audit row) in the same batch; `false`
   * when there is none with this slug, in which case nothing of the batch is kept.
   */
  async archive(
    slug: string,
    archivedAt: string,
    extra: readonly D1PreparedStatement[] = [],
  ): Promise<boolean> {
    // A no-op update would still commit `extra` (a batch is one transaction, not a condition), so the row is
    // checked first; the window between the check and the update only risks a second audit row, never a write.
    const active = await this.findActiveBySlug(slug);
    if (active === null) {
      return false;
    }
    const [result] = await this.db.batch([
      this.db
        .prepare('UPDATE projects SET archived_at = ?2 WHERE slug = ?1 AND archived_at IS NULL')
        .bind(slug, archivedAt),
      ...extra,
    ]);
    return result?.meta.changes === 1;
  }
}

/**
 * Whether the row's snooze mutes at `nowMs`. An expired snooze stays in the row and simply stops counting, so no
 * cleanup job is needed; the api and the hooks Worker both decide through this one comparison.
 */
export function isSnoozedAt(row: ProjectRow, nowMs: number): boolean {
  return row.snoozed_at !== null && (row.snoozed_until === null || Date.parse(row.snoozed_until) > nowMs);
}

/** The row's snooze as the client sees it at `nowMs`. */
export function snoozeOf(row: ProjectRow, nowMs: number): SnoozeDto {
  if (row.snoozed_at === null || !isSnoozedAt(row, nowMs)) {
    return NOT_SNOOZED;
  }
  return {
    snoozed: true,
    until: row.snoozed_until,
    allowsUrgent: row.snooze_allows_urgent !== 0,
    since: row.snoozed_at,
  };
}

/** `nowMs` decides whether the snooze still counts (#221). */
export function toProjectDto(row: ProjectRow, nowMs: number): ProjectDto {
  return {
    slug: row.slug,
    repo: row.repo,
    displayName: row.display_name,
    routineId: row.routine_id,
    addedAt: row.added_at,
    archivedAt: row.archived_at,
    snooze: snoozeOf(row, nowMs),
  };
}
