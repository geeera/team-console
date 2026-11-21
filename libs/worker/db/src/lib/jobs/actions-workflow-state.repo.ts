import type { ActionsSetupStatus } from '@shared/contracts';

/**
 * The last judgement of a project's runner workflow file (#874, migration 0041), kept so "Needs you" can show drift
 * without a GitHub call. Availability only: the exchange and the dispatch never read it.
 */

/** A workflow item's status as the readiness check judges it; `wrong` is never one of the file's. */
export type ActionsWorkflowStoredStatus = Exclude<ActionsSetupStatus, 'wrong'>;

export interface ActionsWorkflowState {
  readonly status: ActionsWorkflowStoredStatus;
  /** The sha256 of the console's rendering it was judged against; `null` when the writer had none. */
  readonly sha256: string | null;
  readonly checkedAt: string;
}

export interface ActionsWorkflowStateRecord extends ActionsWorkflowState {
  readonly projectSlug: string;
}

interface StateRow {
  slug: string;
  actions_workflow_status: ActionsWorkflowStoredStatus;
  actions_workflow_sha256: string | null;
  actions_workflow_checked_at: string;
}

export class ActionsWorkflowStateRepo {
  constructor(private readonly db: D1Database) {}

  /**
   * Records a judgement unless a later one is already stored: two checks finishing out of order never leave the
   * older answer behind. Returns whether the row changed.
   */
  async record(slug: string, state: ActionsWorkflowState): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE projects
         SET actions_workflow_status = ?2, actions_workflow_sha256 = ?3, actions_workflow_checked_at = ?4
         WHERE slug = ?1 AND (actions_workflow_checked_at IS NULL OR actions_workflow_checked_at <= ?4)`,
      )
      .bind(slug, state.status, state.sha256, state.checkedAt)
      .run();
    return result.meta.changes === 1;
  }

  /**
   * The stored judgement of every project of `slugs` that dispatches to Actions and was judged at least once, in one
   * read. A project back on `pull` is left out: its file runs nothing.
   */
  async actionsStatesOf(slugs: readonly string[]): Promise<ActionsWorkflowStateRecord[]> {
    if (slugs.length === 0) {
      return [];
    }
    const { results } = await this.db
      .prepare(
        `SELECT slug, actions_workflow_status, actions_workflow_sha256, actions_workflow_checked_at
         FROM projects
         WHERE slug IN (SELECT value FROM json_each(?1))
           AND dispatch = 'actions'
           AND actions_workflow_status IS NOT NULL
           AND actions_workflow_checked_at IS NOT NULL`,
      )
      .bind(JSON.stringify(slugs))
      .all<StateRow>();
    return results.map((row) => ({
      projectSlug: row.slug,
      status: row.actions_workflow_status,
      sha256: row.actions_workflow_sha256,
      checkedAt: row.actions_workflow_checked_at,
    }));
  }
}
