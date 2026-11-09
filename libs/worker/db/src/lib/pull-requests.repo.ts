import type { SprintCiState } from '@shared/contracts';

export type PullRequestRowState = 'open' | 'closed' | 'merged';

/** A pull request as the provider describes it, already narrowed by the VCS adapter. */
export interface PullRequestSnapshot {
  readonly externalId: string;
  readonly number: number;
  readonly title: string;
  readonly state: PullRequestRowState;
  readonly draft: boolean;
  readonly headRef: string;
  readonly headSha: string;
  readonly baseRef: string;
  readonly authorLogin: string | null;
  readonly url: string;
  /** The provider's last change, `toISOString` form. */
  readonly updatedAt: string;
}

/** One row of `pull_requests` (migration 0020). */
export interface PullRequestRecord extends PullRequestSnapshot {
  readonly projectSlug: string;
  readonly provider: 'github' | 'gitlab';
  readonly itemId: number | null;
  readonly ciState: SprintCiState;
  /** The head's CI changed (a run finished) or was never read since the head moved. */
  readonly ciStale: boolean;
  readonly syncedAt: string;
}

export interface PullRequestWrite {
  /**
   * The provider's repository id the pull request was read or delivered for: the row is written only when it
   * equals the project's `repo_id` (T-2, #466: fail closed — a project without a recorded id takes no row, so a
   * renamed or transferred repository never lands on it; the api Worker backfills the id before it syncs).
   */
  readonly repositoryId: number;
  /** The head's CI read together with the snapshot; absent keeps the row's CI while the head is unchanged. */
  readonly ci?: SprintCiState;
  readonly syncedAt: string;
}

export interface PullRequestFilter {
  /** `undefined`: every state. */
  readonly state?: PullRequestRowState;
}

export interface PullRequestPage {
  readonly items: readonly PullRequestRecord[];
  /** The number to continue `after`, `null` on the last page. */
  readonly next: number | null;
}

interface PullRequestRow {
  project_slug: string;
  provider: 'github' | 'gitlab';
  external_id: string;
  number: number;
  item_id: number | null;
  title: string;
  author_login: string | null;
  head_ref: string;
  head_sha: string;
  base_ref: string;
  state: PullRequestRowState;
  draft: number;
  url: string;
  ci_state: SprintCiState;
  ci_stale: number;
  updated_at: string;
  synced_at: string;
}

const COLUMNS =
  'project_slug, provider, external_id, number, item_id, title, author_login, head_ref, head_sha, base_ref, state, ' +
  'draft, url, ci_state, ci_stale, updated_at, synced_at';

function toRecord(row: PullRequestRow): PullRequestRecord {
  return {
    projectSlug: row.project_slug,
    provider: row.provider,
    externalId: row.external_id,
    number: row.number,
    itemId: row.item_id,
    title: row.title,
    authorLogin: row.author_login,
    headRef: row.head_ref,
    headSha: row.head_sha,
    baseRef: row.base_ref,
    state: row.state,
    draft: row.draft === 1,
    url: row.url,
    ciState: row.ci_state,
    ciStale: row.ci_stale === 1,
    updatedAt: row.updated_at,
    syncedAt: row.synced_at,
  };
}

/**
 * `pull_requests` (#463): the console's mirror of a project's pull requests. Writers are the hooks Worker (signed
 * deliveries) and the api Worker's on-demand sync; neither ever sets `item_id` (2-C links items). Every query is
 * parameterised; the project comes from the admitted route or the registry row, never from a body.
 */
export class PullRequestsRepo {
  constructor(private readonly db: D1Database) {}

  /**
   * Inserts or updates the row of `pull.number`, unless the row already holds a later provider change (two
   * deliveries racing, or a sync after a newer webhook): the older one is dropped. A moved head resets CI to
   * `unknown` + stale unless `write.ci` brings the new head's state. Nothing is written for an archived or
   * unknown project, or when `write.repositoryId` is not the project's recorded `repo_id`. Returns whether a row
   * changed.
   */
  async upsert(slug: string, pull: PullRequestSnapshot, write: PullRequestWrite): Promise<boolean> {
    const hasCi = write.ci !== undefined;
    const result = await this.db
      .prepare(
        `INSERT INTO pull_requests (
           project_slug, provider, external_id, number, title, author_login, head_ref, head_sha, base_ref, state,
           draft, url, ci_state, ci_stale, updated_at, synced_at)
         SELECT p.slug, p.provider, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15
         FROM projects p
         WHERE p.slug = ?1 AND p.archived_at IS NULL AND p.repo_id = ?16
         ON CONFLICT (project_slug, number) DO UPDATE SET
           external_id = excluded.external_id,
           title = excluded.title,
           author_login = excluded.author_login,
           head_ref = excluded.head_ref,
           base_ref = excluded.base_ref,
           state = excluded.state,
           draft = excluded.draft,
           url = excluded.url,
           ci_state = CASE
             WHEN ?17 = 1 THEN excluded.ci_state
             WHEN pull_requests.head_sha = excluded.head_sha THEN pull_requests.ci_state
             ELSE 'unknown' END,
           ci_stale = CASE
             WHEN ?17 = 1 THEN 0
             WHEN pull_requests.head_sha = excluded.head_sha THEN pull_requests.ci_stale
             ELSE 1 END,
           head_sha = excluded.head_sha,
           updated_at = excluded.updated_at,
           synced_at = excluded.synced_at
         WHERE excluded.updated_at >= pull_requests.updated_at`,
      )
      .bind(
        slug,
        pull.externalId,
        pull.number,
        pull.title,
        pull.authorLogin,
        pull.headRef,
        pull.headSha,
        pull.baseRef,
        pull.state,
        pull.draft ? 1 : 0,
        pull.url,
        write.ci ?? 'unknown',
        hasCi ? 0 : 1,
        pull.updatedAt,
        write.syncedAt,
        write.repositoryId,
        hasCi ? 1 : 0,
      )
      .run();
    return result.meta.changes > 0;
  }

  /** The head's CI, read on demand; a head that moved since is left alone (its own read follows). */
  async setCi(
    slug: string,
    number: number,
    headSha: string,
    ci: SprintCiState,
    syncedAt: string,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE pull_requests SET ci_state = ?4, ci_stale = 0, synced_at = ?5
         WHERE project_slug = ?1 AND number = ?2 AND head_sha = ?3`,
      )
      .bind(slug, number, headSha, ci, syncedAt)
      .run();
    return result.meta.changes > 0;
  }

  /**
   * A CI run on `headSha` finished (a delivery): the open pull requests with that head read their CI again. Only the
   * stale flag moves; the state stays what was last read.
   */
  async markCiStale(slug: string, headSha: string, repositoryId: number): Promise<number> {
    const result = await this.db
      .prepare(
        `UPDATE pull_requests SET ci_stale = 1
         WHERE project_slug = ?1 AND head_sha = ?2 AND state = 'open'
           AND EXISTS (SELECT 1 FROM projects p WHERE p.slug = ?1 AND p.repo_id = ?3)`,
      )
      .bind(slug, headSha, repositoryId)
      .run();
    return result.meta.changes;
  }

  async find(slug: string, number: number): Promise<PullRequestRecord | null> {
    const row = await this.db
      .prepare(`SELECT ${COLUMNS} FROM pull_requests WHERE project_slug = ?1 AND number = ?2`)
      .bind(slug, number)
      .first<PullRequestRow>();
    return row === null ? null : toRecord(row);
  }

  /** In number order after `after`, at most `limit` (the route's bound). */
  async list(
    slug: string,
    filter: PullRequestFilter,
    after: number,
    limit: number,
  ): Promise<PullRequestPage> {
    const { results } = await this.db
      .prepare(
        `SELECT ${COLUMNS} FROM pull_requests
         WHERE project_slug = ?1 AND number > ?2 AND (?3 IS NULL OR state = ?3)
         ORDER BY number LIMIT ?4`,
      )
      .bind(slug, after, filter.state ?? null, limit + 1)
      .all<PullRequestRow>();
    const page = results.slice(0, limit).map(toRecord);
    return { items: page, next: results.length > limit ? (page.at(-1)?.number ?? null) : null };
  }

  /** The numbers of the rows still `open`: the on-demand sync re-reads those the provider no longer lists as open. */
  async openNumbers(slug: string): Promise<number[]> {
    const { results } = await this.db
      .prepare(
        `SELECT number FROM pull_requests WHERE project_slug = ?1 AND state = 'open' ORDER BY number DESC`,
      )
      .bind(slug)
      .all<{ number: number }>();
    return results.map((row) => row.number);
  }
}
