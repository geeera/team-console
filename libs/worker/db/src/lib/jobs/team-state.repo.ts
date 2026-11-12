import { TEAM_FAILURE_STREAK_PAUSE } from '@shared/contracts';
import { WROTE_PREVIOUS_STATEMENT, auditEventStatement, type NewAuditEvent } from '../accounts/audit.repo';

/** `team_state` (ADR 0006 "Report", migration 0022): the pause the claim honours and the three-failures stop. */
export interface TeamStateRecord {
  readonly projectSlug: string;
  readonly pausedAt: string | null;
  readonly pausedBy: string | null;
  readonly failedStreak: number;
}

interface TeamStateRow {
  project_slug: string;
  paused_at: string | null;
  paused_by: string | null;
  failed_streak: number;
}

/** Who paused on the failure streak, as `paused_by` records it. */
export const FAILURE_STREAK_PAUSER = 'system:failure-streak';

export class TeamStateRepo {
  constructor(private readonly db: D1Database) {}

  async get(projectSlug: string): Promise<TeamStateRecord> {
    const row = await this.db
      .prepare(`SELECT project_slug, paused_at, paused_by, failed_streak FROM team_state WHERE project_slug = ?1`)
      .bind(projectSlug)
      .first<TeamStateRow>();
    return row === null
      ? { projectSlug, pausedAt: null, pausedBy: null, failedStreak: 0 }
      : { projectSlug, pausedAt: row.paused_at, pausedBy: row.paused_by, failedStreak: row.failed_streak };
  }

  /**
   * `false` when the project was already paused. The write is conditional on the state it changes (#492), so two
   * racing pauses cannot both pass a read-then-write check, and only the one that took effect writes its audit row.
   */
  async pause(projectSlug: string, by: string, now: string, audit: NewAuditEvent): Promise<boolean> {
    const [write] = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO team_state (project_slug, paused_at, paused_by, failed_streak, updated_at) VALUES (?1, ?2, ?3, 0, ?2)
           ON CONFLICT (project_slug) DO UPDATE SET paused_at = excluded.paused_at, paused_by = excluded.paused_by,
             updated_at = excluded.updated_at
           WHERE team_state.paused_at IS NULL`,
        )
        .bind(projectSlug, now, by),
      auditEventStatement(this.db, audit, WROTE_PREVIOUS_STATEMENT),
    ]);
    return (write?.meta.changes ?? 0) === 1;
  }

  /** Resuming also clears the failure streak, as `runlog resume` does. `false` when the project was not paused. */
  async resume(projectSlug: string, now: string, audit: NewAuditEvent): Promise<boolean> {
    const [write] = await this.db.batch([
      this.db
        .prepare(
          `UPDATE team_state SET paused_at = NULL, paused_by = NULL, failed_streak = 0, updated_at = ?2
           WHERE project_slug = ?1 AND paused_at IS NOT NULL`,
        )
        .bind(projectSlug, now),
      auditEventStatement(this.db, audit, WROTE_PREVIOUS_STATEMENT),
    ]);
    return (write?.meta.changes ?? 0) === 1;
  }

  /**
   * Records a job's outcome: a success resets the streak; a failure counts, and the third in a row pauses the project
   * (`paused_by = system:failure-streak`). Returns the streak after the outcome and whether this one paused it.
   */
  async recordOutcome(
    projectSlug: string,
    outcome: 'finished' | 'failed',
    now: string,
    /** The `team.paused` audit row written when this outcome pauses the project (#490 review). */
    pauseAudit?: NewAuditEvent,
  ): Promise<{ readonly failedStreak: number; readonly paused: boolean }> {
    const failed = outcome === 'failed';
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `INSERT INTO team_state (project_slug, paused_at, paused_by, failed_streak, updated_at)
           VALUES (?1, CASE WHEN ?2 >= ?3 THEN ?4 END, CASE WHEN ?2 >= ?3 THEN ?5 END, ?2, ?4)
           ON CONFLICT (project_slug) DO UPDATE SET
             failed_streak = CASE WHEN ?2 = 0 THEN 0 ELSE failed_streak + 1 END,
             paused_at = CASE WHEN ?2 <> 0 AND failed_streak + 1 >= ?3 AND paused_at IS NULL THEN ?4 ELSE paused_at END,
             paused_by = CASE WHEN ?2 <> 0 AND failed_streak + 1 >= ?3 AND paused_at IS NULL THEN ?5 ELSE paused_by END,
             updated_at = ?4
           RETURNING failed_streak, paused_at, paused_by`,
        )
        .bind(projectSlug, failed ? 1 : 0, TEAM_FAILURE_STREAK_PAUSE, now, FAILURE_STREAK_PAUSER),
    ];
    // In the same batch (#492), and only when this outcome is the one that paused: the same test as `paused` below.
    if (failed && pauseAudit !== undefined) {
      statements.push(
        auditEventStatement(this.db, pauseAudit, {
          exists: `SELECT 1 FROM team_state WHERE project_slug = ? AND failed_streak = ? AND paused_by = ? AND paused_at = ?`,
          params: [projectSlug, TEAM_FAILURE_STREAK_PAUSE, FAILURE_STREAK_PAUSER, now],
        }),
      );
    }
    const [upsert] = await this.db.batch<{ failed_streak: number; paused_at: string | null; paused_by: string | null }>(
      statements,
    );
    const row = upsert?.results[0];
    const failedStreak = row?.failed_streak ?? 0;
    const paused =
      failed &&
      failedStreak === TEAM_FAILURE_STREAK_PAUSE &&
      row?.paused_by === FAILURE_STREAK_PAUSER &&
      row.paused_at === now;
    return { failedStreak, paused };
  }
}
