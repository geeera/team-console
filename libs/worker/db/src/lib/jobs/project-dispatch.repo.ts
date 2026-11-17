import type { ProjectDispatch } from '@shared/contracts';
import { auditedWrite, type NewAuditEvent } from '../accounts/audit.repo';
import { subscriptionActionsSql } from '../team-config/access-source';

/**
 * How a project's jobs reach a runner (#670, migration 0031): `pull` (a runner polls the queue) or `actions` (the
 * console starts a workflow run in the project's own repository per job). The switch is one UPDATE that judges every
 * refusal itself, so a team-config or placement write that commits in between cannot slip past a pre-read:
 * - a `subscription` project never goes to Actions (ADR 0009 d.3, #706);
 * - a project whose repository id was never recorded never goes to Actions (the exchange compares the run with it).
 *
 * A placement is no refusal (#728): it applies to the pull claim alone, so on an Actions project a `pinned`/`failover`
 * policy picks the runner of its `needs_local` jobs (the ones that stay `pull`, #695), and its other jobs run on
 * GitHub's machines, which no placement names.
 */

export interface ProjectDispatchRecord {
  readonly dispatch: ProjectDispatch;
  readonly defaultBranch: string | null;
}

export type ProjectDispatchOutcome =
  | { readonly kind: 'saved'; readonly record: ProjectDispatchRecord }
  | { readonly kind: 'access-source-hosted' }
  | { readonly kind: 'repository-unverified' };

export interface ProjectDispatchWrite {
  readonly slug: string;
  readonly dispatch: ProjectDispatch;
  /** GitHub's `default_branch` read for this switch (never input); `null` keeps the stored one. */
  readonly defaultBranch: string | null;
  readonly audit: NewAuditEvent;
}

interface DispatchRow {
  dispatch: ProjectDispatch;
  default_branch: string | null;
}

export class ProjectDispatchRepo {
  constructor(private readonly db: D1Database) {}

  async find(slug: string): Promise<ProjectDispatchRecord | null> {
    const row = await this.db
      .prepare(`SELECT dispatch, default_branch FROM projects WHERE slug = ?1`)
      .bind(slug)
      .first<DispatchRow>();
    return row === null ? null : { dispatch: row.dispatch, defaultBranch: row.default_branch };
  }

  async set(write: ProjectDispatchWrite): Promise<ProjectDispatchOutcome> {
    const [update] = await this.db.batch([
      ...auditedWrite(
        this.db,
        this.db
          .prepare(
            `UPDATE projects SET dispatch = ?2, default_branch = COALESCE(?3, default_branch)
             WHERE slug = ?1
               AND NOT ${subscriptionActionsSql('?1', '?2')}
               AND NOT (?2 = 'actions' AND repo_id IS NULL)`,
          )
          .bind(write.slug, write.dispatch, write.defaultBranch),
        write.audit,
      ),
    ]);
    if (update?.meta.changes === 1) {
      const record = await this.find(write.slug);
      if (record !== null) {
        return { kind: 'saved', record };
      }
    }
    // The UPDATE judged it; this read only names which refusal held.
    const row = await this.db
      .prepare(
        `SELECT p.access_source FROM projects p WHERE p.slug = ?1`,
      )
      .bind(write.slug)
      .first<{ access_source: string }>();
    if (row?.access_source === 'subscription') {
      return { kind: 'access-source-hosted' };
    }
    return { kind: 'repository-unverified' };
  }

  /**
   * GitHub's current default branch, read right before a dispatch (#695 item 4): a renamed default branch is picked
   * up before any run on it, so the exchange never compares a run with a branch that is no longer the default.
   */
  async recordDefaultBranch(slug: string, branch: string): Promise<void> {
    await this.db
      .prepare(`UPDATE projects SET default_branch = ?2 WHERE slug = ?1 AND default_branch IS NOT ?2`)
      .bind(slug, branch)
      .run();
  }
}
