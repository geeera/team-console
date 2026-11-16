import { PLAN_ENTITLEMENTS, TEAM_FAILURE_STREAK_PAUSE, entitlementsOf, isRunnerLimitReason } from '@shared/contracts';
import { AccountsRepo } from '../accounts/accounts.repo';
import { auditEventStatement, auditedWrite, type NewAuditEvent } from '../accounts/audit.repo';

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

/**
 * A pause that lapsed this recently still backs a limit failure (#596): a short `retryAt` can pass between the
 * runner's pause post and its finish, and the two clocks differ by seconds.
 */
export const RUNNER_PAUSE_GRACE_MS = 2 * 60 * 1000;

/**
 * The floor of the exclusion budget per window (#658). A pause has no minimum length and the runner can lift it at
 * once, so the pause alone cannot stop a rogue runner from failing jobs "on a limit" for ever; past the budget its limit
 * failures count like any other. Sized above a legitimate burst: every job in flight when a quota is hit fails
 * together, so the budget grows to the in-flight bound when that is larger (#705).
 *
 * Two budgets hold at once (#701), both counted from the window's `job.streak-excluded` rows:
 * - per runner: `max(floor, min(declared maxConcurrency, entitled concurrency))` — the declaration is the runner's own
 *   word, so the account's entitlement caps it;
 * - per project: `max(floor, entitled concurrency)` — the account's runners together are entitled to that many jobs
 *   at once, so a well-behaved account stays under it however many runners it has, while a fresh runner id per job
 *   (Actions, #669) or many runners on one project no longer each bring a budget of their own.
 */
export const RUNNER_EXCLUSION_BUDGET = 5;
export const RUNNER_EXCLUSION_WINDOW_MS = 60 * 60 * 1000;

/** A failure the runner says hit a usage or rate limit (#571): `reason` is `metrics.reason` from its finish. */
export interface StreakLimitClaim {
  readonly reason: unknown;
  readonly runnerId: string;
  readonly accountId: string;
  /** Written when the failure is left out of the streak. */
  readonly audit: NewAuditEvent;
}

export interface StreakOutcome {
  readonly failedStreak: number;
  readonly paused: boolean;
  /** The failure was a limit backed by the runner's pause, and the streak left it out. */
  readonly excluded: boolean;
}

/** The account's `job.streak-excluded` rows inside the window, narrowed by `scope`. */
const excludedInWindow = (accountId: string, windowFrom: string, scope: string): string =>
  `(SELECT COUNT(*) FROM audit_events WHERE account_id = ${accountId} AND kind = 'job.streak-excluded'
      AND julianday(at) > julianday(${windowFrom}) AND ${scope})`;

/**
 * The finishing runner holds a pause in force, or one that lapsed inside the grace window, and neither it nor the
 * project has used up its exclusion budget (#658, #701, #705). The runner's declared concurrency is read from its own
 * row, never from the caller, and both counts are judged by the statement that writes, so two racing finishes cannot
 * both pass a read-then-write check.
 */
const heldPauseOf = (
  runnerId: string,
  accountId: string,
  graceFrom: string,
  windowFrom: string,
  projectSlug: string,
  entitledConcurrency: string,
): string =>
  `SELECT 1 FROM runners WHERE id = ${runnerId} AND account_id = ${accountId} AND revoked_at IS NULL
     AND paused_until IS NOT NULL AND julianday(paused_until) > julianday(${graceFrom})
     AND ${excludedInWindow(accountId, windowFrom, `actor_kind = 'runner' AND actor = ${runnerId}`)}
       < MAX(${RUNNER_EXCLUSION_BUDGET}, MIN(COALESCE(json_extract(capabilities, '$.maxConcurrency'), 1), ${entitledConcurrency}))
     AND ${excludedInWindow(accountId, windowFrom, `json_extract(details, '$.slug') = ${projectSlug}`)}
       < MAX(${RUNNER_EXCLUSION_BUDGET}, ${entitledConcurrency})`;

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
      ...auditedWrite(
        this.db,
        this.db
          .prepare(
            `INSERT INTO team_state (project_slug, paused_at, paused_by, failed_streak, updated_at) VALUES (?1, ?2, ?3, 0, ?2)
             ON CONFLICT (project_slug) DO UPDATE SET paused_at = excluded.paused_at, paused_by = excluded.paused_by,
               updated_at = excluded.updated_at
             WHERE team_state.paused_at IS NULL`,
          )
          .bind(projectSlug, now, by),
        audit,
      ),
    ]);
    return (write?.meta.changes ?? 0) === 1;
  }

  /** Resuming also clears the failure streak, as `runlog resume` does. `false` when the project was not paused. */
  async resume(projectSlug: string, now: string, audit: NewAuditEvent): Promise<boolean> {
    const [write] = await this.db.batch([
      ...auditedWrite(
        this.db,
        this.db
          .prepare(
            `UPDATE team_state SET paused_at = NULL, paused_by = NULL, failed_streak = 0, updated_at = ?2
             WHERE project_slug = ?1 AND paused_at IS NOT NULL`,
          )
          .bind(projectSlug, now),
        audit,
      ),
    ]);
    return (write?.meta.changes ?? 0) === 1;
  }

  /**
   * Records a job's outcome: a success resets the streak; a failure counts, and the third in a row pauses the project
   * (`paused_by = system:failure-streak`). A failure on a usage or rate limit (#571) is neither, but only while the
   * finishing runner holds a pause (#596): the reason is the runner's own word, so without its pause row to back it the
   * failure counts like any other. An excluded failure writes `limit.audit`, in the same batch. Returns the streak after
   * the outcome, whether this one paused it, and whether the streak left it out.
   */
  async recordOutcome(
    projectSlug: string,
    outcome: 'finished' | 'failed',
    now: string,
    /** The `team.paused` audit row written when this outcome pauses the project (#490 review). */
    pauseAudit?: NewAuditEvent,
    limit?: StreakLimitClaim,
  ): Promise<StreakOutcome> {
    const failed = outcome === 'failed';
    const claim = failed && limit !== undefined && isRunnerLimitReason(limit.reason) ? limit : null;
    // Read only for a limit claim. A plan change between this read and the write is harmless: the counts stay inside it.
    const entitledConcurrency =
      claim === null ? PLAN_ENTITLEMENTS.free.maxConcurrency : await this.entitledConcurrencyOf(claim.accountId);
    // A NULL runner (no limit claimed) makes the held-pause guards pass, so the outcome counts as before.
    const heldPause = [
      claim?.runnerId ?? null,
      claim?.accountId ?? null,
      new Date(Date.parse(now) - RUNNER_PAUSE_GRACE_MS).toISOString(),
      new Date(Date.parse(now) - RUNNER_EXCLUSION_WINDOW_MS).toISOString(),
      projectSlug,
      entitledConcurrency,
    ] as const;
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `INSERT INTO team_state (project_slug, paused_at, paused_by, failed_streak, updated_at)
           SELECT ?1, CASE WHEN ?2 >= ?3 THEN ?4 END, CASE WHEN ?2 >= ?3 THEN ?5 END, ?2, ?4
           WHERE ?6 IS NULL OR NOT EXISTS (${heldPauseOf('?6', '?7', '?8', '?9', '?10', '?11')})
           ON CONFLICT (project_slug) DO UPDATE SET
             failed_streak = CASE WHEN ?2 = 0 THEN 0 ELSE failed_streak + 1 END,
             paused_at = CASE WHEN ?2 <> 0 AND failed_streak + 1 >= ?3 AND paused_at IS NULL THEN ?4 ELSE paused_at END,
             paused_by = CASE WHEN ?2 <> 0 AND failed_streak + 1 >= ?3 AND paused_at IS NULL THEN ?5 ELSE paused_by END,
             updated_at = ?4
           RETURNING failed_streak, paused_at, paused_by`,
        )
        .bind(projectSlug, failed ? 1 : 0, TEAM_FAILURE_STREAK_PAUSE, now, FAILURE_STREAK_PAUSER, ...heldPause),
    ];
    // In the same batch (#492), and only when this outcome is the one that paused: the same test as `paused` below.
    if (failed && pauseAudit !== undefined) {
      statements.push(
        auditEventStatement(this.db, pauseAudit, {
          // ?1-?8 are the audit row's own values; the held-pause test reuses its parameters in several places.
          exists: `SELECT 1 FROM team_state WHERE project_slug = ?9 AND failed_streak = ?10 AND paused_by = ?11 AND paused_at = ?12
                   AND (?13 IS NULL OR NOT EXISTS (${heldPauseOf('?13', '?14', '?15', '?16', '?17', '?18')}))`,
          params: [projectSlug, TEAM_FAILURE_STREAK_PAUSE, FAILURE_STREAK_PAUSER, now, ...heldPause],
        }),
      );
    }
    if (claim !== null) {
      // The project budget counts `details.slug`, so the repo writes it rather than trusting the caller's details.
      const excludedAudit: NewAuditEvent = { ...claim.audit, details: { ...claim.audit.details, slug: projectSlug } };
      statements.push(
        auditEventStatement(this.db, excludedAudit, {
          exists: heldPauseOf('?9', '?10', '?11', '?12', '?13', '?14'),
          params: [...heldPause],
        }),
      );
    }
    const [upsert, ...audits] = await this.db.batch<{
      failed_streak: number;
      paused_at: string | null;
      paused_by: string | null;
    }>(statements);
    if (claim !== null && (audits[audits.length - 1]?.meta.changes ?? 0) === 1) {
      return { failedStreak: (await this.get(projectSlug)).failedStreak, paused: false, excluded: true };
    }
    const row = upsert?.results[0];
    const failedStreak = row?.failed_streak ?? 0;
    const paused =
      failed &&
      failedStreak === TEAM_FAILURE_STREAK_PAUSE &&
      row?.paused_by === FAILURE_STREAK_PAUSER &&
      row.paused_at === now;
    return { failedStreak, paused, excluded: false };
  }

  private async entitledConcurrencyOf(accountId: string): Promise<number> {
    const account = await new AccountsRepo(this.db).findById(accountId);
    // No account row: the free tier, as `entitlementsOf` itself fails closed.
    return (account === null ? PLAN_ENTITLEMENTS.free : entitlementsOf(account)).maxConcurrency;
  }
}
