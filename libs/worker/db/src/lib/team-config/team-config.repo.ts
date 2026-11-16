import { BUDGET_PAUSER, type AccessSource, type TeamConfig, type TeamConfigChange } from '@shared/contracts';
import { AUDITED_WRITE_HAPPENED_SQL, auditedWrite, type NewAuditEvent } from '../accounts/audit.repo';
import { subscriptionHostedSql } from './access-source';

/**
 * Team configuration storage (ADR 0009 d.7, d.8, migration 0032): `team_configs` holds the project's current document,
 * `team_config_revisions` its append-only history, and `projects.access_source` the document's `access.source` for
 * the claim's WHERE. This repo is their only writer; a save is one batch with its audit row, so the three move
 * together or not at all, and `team_configs.revision` always equals the highest revision.
 */

export interface TeamConfigRecord {
  readonly projectSlug: string;
  readonly revision: number;
  readonly config: TeamConfig;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface TeamConfigRevisionRecord {
  readonly projectSlug: string;
  readonly revision: number;
  readonly config: TeamConfig;
  readonly diff: readonly TeamConfigChange[];
  readonly reason: string | null;
  readonly createdAt: string;
  readonly createdBy: string;
}

/** One save. `config` is checked by `checkTeamConfig` and carries `access`, so every revision names its source. */
export interface TeamConfigWrite {
  readonly projectSlug: string;
  /** The revision the writer read (`If-Match`); 0 for a project with no document yet. */
  readonly expectedRevision: number;
  readonly config: TeamConfig & { readonly access: { readonly source: AccessSource } };
  readonly diff: readonly TeamConfigChange[];
  /** Redacted and bounded by the caller. */
  readonly reason: string | null;
  /** The revision row's id (a ULID); never part of a path or a lookup. */
  readonly id: string;
  readonly at: string;
  readonly by: string;
  readonly audit: NewAuditEvent;
}

export type TeamConfigSaveOutcome =
  | { readonly kind: 'saved'; readonly revision: number }
  /** Another write moved the revision since `expectedRevision` was read (or it never was that revision). */
  | { readonly kind: 'stale'; readonly revision: number }
  /** `subscription` while a hosted runner or an Actions dispatch could run the project (ADR 0009 d.3). */
  | { readonly kind: 'access-source-hosted' };

interface CurrentRow {
  project_slug: string;
  revision: number;
  config: string;
  updated_at: string;
  updated_by: string;
}

interface RevisionRow {
  project_slug: string;
  revision: number;
  config: string;
  diff: string;
  reason: string | null;
  created_at: string;
  created_by: string;
}

// The columns are CHECKed as JSON; a parse failure is a broken database, not input.
const parsed = <T>(json: string): T => JSON.parse(json) as T;

function toRevision(row: RevisionRow): TeamConfigRevisionRecord {
  return {
    projectSlug: row.project_slug,
    revision: row.revision,
    config: parsed<TeamConfig>(row.config),
    diff: parsed<TeamConfigChange[]>(row.diff),
    reason: row.reason,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

const REVISION_COLUMNS = 'project_slug, revision, config, diff, reason, created_at, created_by';

export class TeamConfigRepo {
  constructor(private readonly db: D1Database) {}

  async findCurrent(projectSlug: string): Promise<TeamConfigRecord | null> {
    const row = await this.db
      .prepare(`SELECT project_slug, revision, config, updated_at, updated_by FROM team_configs WHERE project_slug = ?1`)
      .bind(projectSlug)
      .first<CurrentRow>();
    return row === null
      ? null
      : {
          projectSlug: row.project_slug,
          revision: row.revision,
          config: parsed<TeamConfig>(row.config),
          updatedAt: row.updated_at,
          updatedBy: row.updated_by,
        };
  }

  /** A revision of the project, addressed by `(project_slug, revision)` only. */
  async findRevision(projectSlug: string, revision: number): Promise<TeamConfigRevisionRecord | null> {
    const row = await this.db
      .prepare(`SELECT ${REVISION_COLUMNS} FROM team_config_revisions WHERE project_slug = ?1 AND revision = ?2`)
      .bind(projectSlug, revision)
      .first<RevisionRow>();
    return row === null ? null : toRevision(row);
  }

  /** Oldest first after `after`, at most `limit + 1` so the caller sees the next page. */
  async listRevisions(projectSlug: string, after: number, limit: number): Promise<TeamConfigRevisionRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${REVISION_COLUMNS} FROM team_config_revisions WHERE project_slug = ?1 AND revision > ?2
         ORDER BY revision LIMIT ?3`,
      )
      .bind(projectSlug, after, limit + 1)
      .all<RevisionRow>();
    return results.map(toRevision);
  }

  /** `projects.access_source`: what a project with no document resolves `access.source` from. */
  async accessSourceOf(projectSlug: string): Promise<AccessSource | null> {
    const row = await this.db
      .prepare(`SELECT access_source FROM projects WHERE slug = ?1`)
      .bind(projectSlug)
      .first<{ access_source: AccessSource }>();
    return row?.access_source ?? null;
  }

  /**
   * The compare-and-set save (threat model C12 row 1): the current row moves from `expectedRevision` to the next one
   * only if it still is `expectedRevision` and the access rule holds, both judged by the write itself; the revision
   * row, the audit row and `projects.access_source` follow only if it did. Of two saves on the same revision one
   * writes; the other is `stale`.
   */
  async save(write: TeamConfigWrite): Promise<TeamConfigSaveOutcome> {
    const json = JSON.stringify(write.config);
    const next = write.expectedRevision + 1;
    const refused = subscriptionHostedSql('?1', `json_extract(?2, '$.access.source')`);
    const current =
      write.expectedRevision === 0
        ? this.db
            .prepare(
              `INSERT INTO team_configs (project_slug, revision, config, updated_at, updated_by)
               SELECT ?1, 1, ?2, ?3, ?4
               WHERE NOT EXISTS (SELECT 1 FROM team_configs WHERE project_slug = ?1) AND NOT ${refused}`,
            )
            .bind(write.projectSlug, json, write.at, write.by)
        : this.db
            .prepare(
              `UPDATE team_configs SET revision = ?5, config = ?2, updated_at = ?3, updated_by = ?4
               WHERE project_slug = ?1 AND revision = ?6 AND NOT ${refused}`,
            )
            .bind(write.projectSlug, json, write.at, write.by, next, write.expectedRevision);
    const results = await this.db.batch([
      // The audit row is written only if the compare-and-set took; the revision row only if the audit row was.
      ...auditedWrite(this.db, current, write.audit),
      this.db
        .prepare(
          `INSERT INTO team_config_revisions (id, project_slug, revision, config, diff, reason, created_at, created_by)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8 WHERE ${AUDITED_WRITE_HAPPENED_SQL}`,
        )
        .bind(write.id, write.projectSlug, next, json, JSON.stringify(write.diff), write.reason, write.at, write.by),
      this.db
        .prepare(
          `UPDATE projects SET access_source = ?2
           WHERE slug = ?1 AND access_source IS NOT ?2 AND EXISTS (SELECT 1 FROM team_config_revisions WHERE id = ?3)`,
        )
        .bind(write.projectSlug, write.config.access.source, write.id),
      ...this.budgetStopStatements(write, json),
    ]);
    if (results[2]?.meta.changes === 1) {
      return { kind: 'saved', revision: next };
    }
    const after = await this.findCurrent(write.projectSlug);
    const revision = after?.revision ?? 0;
    return revision === write.expectedRevision ? { kind: 'access-source-hosted' } : { kind: 'stale', revision };
  }

  /**
   * The budget stop follows the saved budget (#684), in the save's batch and only if the save took (its revision row
   * exists): a budget raised above the month's spend, or removed, lifts a `system:budget` pause ("Raise budget"); one
   * lowered to the spend or below pauses the team at once with the same Needs-you row a `finish` would raise, so the
   * owner sees why nothing starts. Only a `system:budget` pause is ever lifted or set here: an owner's or the failure
   * streak's pause stays as it is. A budget saved above the spend of a month the owner waived ("Resume this month")
   * ends the waiver (#734), so the new budget caps the rest of that month.
   */
  private budgetStopStatements(write: TeamConfigWrite, json: string): D1PreparedStatement[] {
    const reached = `EXISTS (
      SELECT 1 FROM project_spend ps
      WHERE ps.project_slug = ?1 AND ps.month = substr(?2, 1, 7) AND ps.waived_at IS NULL
        AND ps.spent_usd >= json_extract(?3, '$.budget.monthly_usd'))`;
    const saved = `EXISTS (SELECT 1 FROM team_config_revisions WHERE id = ?4)`;
    const audit = (kind: 'team.paused' | 'team.resumed'): NewAuditEvent => ({
      ...write.audit,
      kind,
      target: write.projectSlug,
      details: { reason: 'budget', revision: write.expectedRevision + 1 },
    });
    return [
      // First, so the terms below judge the month under the new budget.
      this.db
        .prepare(
          `UPDATE project_spend SET waived_at = NULL
           WHERE project_slug = ?1 AND month = substr(?2, 1, 7) AND waived_at IS NOT NULL AND ${saved}
             AND spent_usd < json_extract(?3, '$.budget.monthly_usd')`,
        )
        .bind(write.projectSlug, write.at, json, write.id),
      ...auditedWrite(
        this.db,
        this.db
          .prepare(
            `UPDATE team_state SET paused_at = NULL, paused_by = NULL, updated_at = ?2
             WHERE project_slug = ?1 AND paused_at IS NOT NULL AND paused_by = ?5 AND ${saved} AND NOT ${reached}`,
          )
          .bind(write.projectSlug, write.at, json, write.id, BUDGET_PAUSER),
        audit('team.resumed'),
      ),
      ...auditedWrite(
        this.db,
        this.db
          .prepare(
            `INSERT INTO team_state (project_slug, paused_at, paused_by, failed_streak, updated_at)
             SELECT ?1, ?2, ?5, 0, ?2 WHERE ${saved} AND ${reached}
             ON CONFLICT (project_slug) DO UPDATE SET paused_at = excluded.paused_at, paused_by = excluded.paused_by,
               updated_at = excluded.updated_at
             WHERE team_state.paused_at IS NULL`,
          )
          .bind(write.projectSlug, write.at, json, write.id, BUDGET_PAUSER),
        audit('team.paused'),
      ),
    ];
  }
}
