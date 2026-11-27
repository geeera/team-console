import {
  RUNNER_CHECK_PICKUP_SECONDS,
  RUNNER_CHECK_RETENTION_DAYS,
  RUNNER_CHECK_RUNNING_SECONDS,
  type AuditActorKind,
  type FinishRunnerCheckInput,
  type RunnerCheckKind,
  type RunnerCheckState,
  type RunnerExpiredCheckReason,
  type RunnerStoredCheckReason,
} from '@shared/contracts';
import { auditedWrite } from '../accounts/audit.repo';
import { isConstraintError } from '../tracker/constraint-error';

/**
 * Runner checks (#1059, migration 0049; security note S1–S12). The only reader and writer of `runner_checks`: every
 * statement names the runner **and** its account, both from the caller's identity (the owner's account route, or the
 * runner's JWT), never from a body. A check is advisory: nothing in the claim, placement or `jobs` reads this table.
 * Every state change writes its audit row in its own batch, through `auditedWrite`, so the redactor runs on `details`
 * and a write that lost a race leaves no row.
 */

export interface RunnerCheckRecord {
  readonly id: string;
  readonly accountId: string;
  readonly runnerId: string;
  readonly kind: RunnerCheckKind;
  readonly requestedBy: string;
  readonly state: RunnerCheckState;
  readonly reason: RunnerStoredCheckReason | null;
  readonly claudeVersion: string | null;
  readonly durationMs: number | null;
  readonly createdAt: string;
  readonly pickedAt: string | null;
  readonly finishedAt: string | null;
}

export interface NewRunnerCheck {
  readonly id: string;
  readonly accountId: string;
  readonly runnerId: string;
  readonly kind: RunnerCheckKind;
  readonly at: string;
}

/** Who asked: the audit actor of the owner's identity (`requested_by` and the audit row's actor). */
export interface RunnerCheckRequester {
  readonly actorKind: AuditActorKind;
  readonly actor: string;
  readonly ipCountry: string | null;
}

/** The hourly caps a creation is judged against inside its own INSERT (S12): created rows only. */
export interface RunnerCheckCaps {
  readonly perRunner: number;
  readonly perAccount: number;
}

export type CreateCheckOutcome =
  | { readonly kind: 'created'; readonly check: RunnerCheckRecord }
  /** A check was already in flight (a replay, or the unique-index race): that one, nothing written. */
  | { readonly kind: 'live'; readonly check: RunnerCheckRecord }
  | { readonly kind: 'rate-limited'; readonly retryAfterSeconds: number }
  /** The runner's row no longer admits a check (revoked, paused or undeclared since the caller read it). */
  | { readonly kind: 'refused' };

/** The audit actor of the server's own expiry. */
const EXPIRY_ACTOR = 'runner-checks';
const HOUR_SECONDS = 60 * 60;

interface RunnerCheckRow {
  id: string;
  account_id: string;
  runner_id: string;
  kind: RunnerCheckKind;
  requested_by: string;
  state: RunnerCheckState;
  reason: RunnerStoredCheckReason | null;
  claude_version: string | null;
  duration_ms: number | null;
  created_at: string;
  picked_at: string | null;
  finished_at: string | null;
}

const COLUMNS = `id, account_id, runner_id, kind, requested_by, state, reason, claude_version, duration_ms, created_at,
  picked_at, finished_at`;

function toRecord(row: RunnerCheckRow): RunnerCheckRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    runnerId: row.runner_id,
    kind: row.kind,
    requestedBy: row.requested_by,
    state: row.state,
    reason: row.reason,
    claudeVersion: row.claude_version,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
    pickedAt: row.picked_at,
    finishedAt: row.finished_at,
  };
}

/**
 * The runner aliased `r` admits a check at the time bound to `now` (S10): not revoked, not paused, a self-hosted
 * identity (never hosted or `actions-ephemeral`). Its account is the check's (the 0049 trigger), named here as well.
 */
function runnerTakesChecksSql(runnerId: string, accountId: string, now: string): string {
  return `EXISTS (
    SELECT 1 FROM runners r
    WHERE r.id = ${runnerId} AND r.account_id = ${accountId} AND r.revoked_at IS NULL
      AND r.hosted = 0 AND r.isolation <> 'actions-ephemeral'
      AND (r.paused_until IS NULL OR julianday(r.paused_until) <= julianday(${now}))
  )`;
}

/** A live check whose clock ran out at the time bound to `now` (§2 "Stale checks"). */
const STALE_SQL = (now: string): string => `(
  (state = 'queued' AND julianday(created_at) <= julianday(${now}, '-${String(RUNNER_CHECK_PICKUP_SECONDS)} seconds'))
  OR (state = 'running' AND julianday(picked_at) <= julianday(${now}, '-${String(RUNNER_CHECK_RUNNING_SECONDS)} seconds'))
)`;

export class RunnerChecksRepo {
  constructor(private readonly db: D1Database) {}

  /** A check of this runner of this account (S9): another runner's, or another account's, is `null` like none. */
  async findOfRunner(accountId: string, runnerId: string, id: string): Promise<RunnerCheckRecord | null> {
    const row = await this.db
      .prepare(`SELECT ${COLUMNS} FROM runner_checks WHERE id = ?1 AND runner_id = ?2 AND account_id = ?3`)
      .bind(id, runnerId, accountId)
      .first<RunnerCheckRow>();
    return row === null ? null : toRecord(row);
  }

  /** The runner's check in flight, if any (at most one: the partial unique index). */
  async findLive(accountId: string, runnerId: string): Promise<RunnerCheckRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT ${COLUMNS} FROM runner_checks
         WHERE runner_id = ?1 AND account_id = ?2 AND state IN ('queued', 'running')`,
      )
      .bind(runnerId, accountId)
      .first<RunnerCheckRow>();
    return row === null ? null : toRecord(row);
  }

  /**
   * The lazy sweep (no cron): the runner's queued check older than `RUNNER_CHECK_PICKUP_SECONDS` becomes
   * `not-picked-up`, its running one older than `RUNNER_CHECK_RUNNING_SECONDS` since the pick-up `lost`, each with its
   * `runner.check-expired` row. Each write re-judges its own clock, so a finish that won the race is never overwritten.
   */
  async expireStale(accountId: string, runnerId: string, now: string): Promise<number> {
    const { results } = await this.db
      .prepare(
        `SELECT ${COLUMNS} FROM runner_checks WHERE runner_id = ?1 AND account_id = ?2 AND ${STALE_SQL('?3')}`,
      )
      .bind(runnerId, accountId, now)
      .all<RunnerCheckRow>();
    if (results.length === 0) {
      return 0;
    }
    const statements = results.flatMap((row) =>
      this.expireStatements(
        toRecord(row),
        row.state === 'queued' ? 'not-picked-up' : 'lost',
        now,
        `AND state = ?5 AND ${STALE_SQL('?3')}`,
        [row.state],
      ),
    );
    const written = await this.db.batch(statements);
    // Every other statement is an audit row; the expiries are at the even positions.
    return written.filter((result, index) => index % 2 === 0 && result.meta.changes === 1).length;
  }

  /**
   * The revoke's batch (§2, S7): the runner's live checks become `failed`/`runner-revoked`, each with its expired row.
   * Read before the batch; a check created after the read cannot be picked up (the pick-up refuses a revoked runner)
   * and is swept as `not-picked-up`.
   */
  async failLiveOnRevokeStatements(
    accountId: string,
    runnerId: string,
    at: string,
  ): Promise<readonly D1PreparedStatement[]> {
    const live = await this.findLive(accountId, runnerId);
    return live === null
      ? []
      : this.expireStatements(live, 'runner-revoked', at, `AND state IN ('queued', 'running')`, []);
  }

  private expireStatements(
    check: RunnerCheckRecord,
    reason: RunnerExpiredCheckReason,
    at: string,
    condition: string,
    params: readonly string[],
  ): readonly [D1PreparedStatement, D1PreparedStatement] {
    return auditedWrite(
      this.db,
      this.db
        .prepare(
          `UPDATE runner_checks SET state = 'failed', reason = ?4, finished_at = ?3
           WHERE id = ?1 AND account_id = ?2 ${condition}`,
        )
        .bind(check.id, check.accountId, at, reason, ...params),
      {
        accountId: check.accountId,
        at,
        actorKind: 'system',
        actor: EXPIRY_ACTOR,
        kind: 'runner.check-expired',
        target: check.runnerId,
        details: { checkId: check.id, reason },
        ipCountry: null,
      },
    );
  }

  /**
   * Starts a check (§2, S12): the 30-day prune of the runner's finished checks, the INSERT and its
   * `runner.check-requested` row, in one batch. The INSERT judges the caps (created rows of the last hour, per runner
   * and per account) and the runner's row (not revoked, not paused, self-hosted, `smoke` declared); the partial
   * unique index refuses a second live check, which answers as `live` with the one in flight, never as an error.
   */
  async create(
    check: NewRunnerCheck,
    requester: RunnerCheckRequester,
    caps: RunnerCheckCaps,
  ): Promise<CreateCheckOutcome> {
    const lastHour = (column: string, value: string): string =>
      `SELECT COUNT(*) FROM runner_checks WHERE ${column} = ${value}
         AND julianday(created_at) > julianday(?5, '-${String(HOUR_SECONDS)} seconds')`;
    const declared = `EXISTS (SELECT 1 FROM runners d, json_each(d.capabilities, '$.checks') k
      WHERE d.id = ?3 AND k.value = ?4)`;
    try {
      const [, insert] = await this.db.batch([
        this.db
          .prepare(
            `DELETE FROM runner_checks WHERE runner_id = ?1 AND state IN ('passed', 'failed')
               AND julianday(created_at) < julianday(?2, '-${String(RUNNER_CHECK_RETENTION_DAYS)} days')`,
          )
          .bind(check.runnerId, check.at),
        ...auditedWrite(
          this.db,
          this.db
            .prepare(
              `INSERT INTO runner_checks (id, account_id, runner_id, kind, requested_by, created_at)
               SELECT ?1, ?2, ?3, ?4, ?6, ?5
               WHERE (${lastHour('runner_id', '?3')}) < ?7 AND (${lastHour('account_id', '?2')}) < ?8
                 AND ${runnerTakesChecksSql('?3', '?2', '?5')} AND ${declared}`,
            )
            .bind(
              check.id,
              check.accountId,
              check.runnerId,
              check.kind,
              check.at,
              requester.actor,
              caps.perRunner,
              caps.perAccount,
            ),
          {
            accountId: check.accountId,
            at: check.at,
            actorKind: requester.actorKind,
            actor: requester.actor,
            kind: 'runner.check-requested',
            target: check.runnerId,
            details: { checkId: check.id, kind: check.kind },
            ipCountry: requester.ipCountry,
          },
        ),
      ]);
      if ((insert?.meta.changes ?? 0) === 1) {
        const created = await this.findOfRunner(check.accountId, check.runnerId, check.id);
        if (created === null) {
          throw new Error('a created runner check has no row');
        }
        return { kind: 'created', check: created };
      }
    } catch (error: unknown) {
      if (!isConstraintError(error, 'UNIQUE constraint failed: runner_checks.runner_id')) {
        throw error;
      }
      const live = await this.findLive(check.accountId, check.runnerId);
      // The index held for a check that then finished: the caller's next request starts a fresh one.
      return live === null ? { kind: 'refused' } : { kind: 'live', check: live };
    }
    const retryAfterSeconds = await this.retryAfterOf(check, caps);
    return retryAfterSeconds === null ? { kind: 'refused' } : { kind: 'rate-limited', retryAfterSeconds };
  }

  /** Seconds until the fuller cap frees a slot (the oldest counted row leaves the hour); `null` when neither holds. */
  private async retryAfterOf(check: NewRunnerCheck, caps: RunnerCheckCaps): Promise<number | null> {
    const window = `julianday(created_at) > julianday(?3, '-${String(HOUR_SECONDS)} seconds')`;
    const row = await this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM runner_checks WHERE runner_id = ?1 AND ${window}) AS runner_count,
           (SELECT MIN(created_at) FROM runner_checks WHERE runner_id = ?1 AND ${window}) AS runner_oldest,
           (SELECT COUNT(*) FROM runner_checks WHERE account_id = ?2 AND ${window}) AS account_count,
           (SELECT MIN(created_at) FROM runner_checks WHERE account_id = ?2 AND ${window}) AS account_oldest`,
      )
      .bind(check.runnerId, check.accountId, check.at)
      .first<{
        runner_count: number;
        runner_oldest: string | null;
        account_count: number;
        account_oldest: string | null;
      }>();
    if (row === null) {
      return null;
    }
    const now = Date.parse(check.at);
    const waits: number[] = [];
    if (row.runner_count >= caps.perRunner && row.runner_oldest !== null) {
      waits.push(Date.parse(row.runner_oldest) + HOUR_SECONDS * 1000 - now);
    }
    if (row.account_count >= caps.perAccount && row.account_oldest !== null) {
      waits.push(Date.parse(row.account_oldest) + HOUR_SECONDS * 1000 - now);
    }
    return waits.length === 0 ? null : Math.max(1, Math.ceil(Math.max(...waits) / 1000));
  }

  /**
   * Delivery (§1, S1, S10): the runner's queued check of a kind this poll declares, picked up by one statement. Runner
   * and account come from the JWT; the runner must be unrevoked and unpaused; a check older than the pick-up window is
   * never taken. `null` when there is none.
   */
  async pickUp(
    accountId: string,
    runnerId: string,
    declared: readonly RunnerCheckKind[],
    now: string,
  ): Promise<{ readonly id: string; readonly kind: RunnerCheckKind } | null> {
    if (declared.length === 0) {
      return null;
    }
    return this.db
      .prepare(
        `UPDATE runner_checks SET state = 'running', picked_at = ?3
         WHERE id = (
           SELECT id FROM runner_checks
           WHERE runner_id = ?1 AND account_id = ?2 AND state = 'queued'
             AND kind IN (SELECT value FROM json_each(?4))
             AND julianday(created_at) > julianday(?3, '-${String(RUNNER_CHECK_PICKUP_SECONDS)} seconds')
           ORDER BY created_at, id
           LIMIT 1
         )
         AND ${runnerTakesChecksSql('?1', '?2', '?3')}
         RETURNING id, kind`,
      )
      .bind(runnerId, accountId, now, JSON.stringify(declared))
      .first<{ id: string; kind: RunnerCheckKind }>();
  }

  /**
   * The runner's report (S5, T2): one UPDATE that requires this runner's own `running` check of its own account,
   * picked up less than `RUNNER_CHECK_RUNNING_SECONDS` ago, with its `runner.check-finished` row. `false` for
   * everything else: a second finish, a queued, foreign or late check.
   */
  async finish(
    check: Pick<RunnerCheckRecord, 'id' | 'accountId' | 'runnerId' | 'kind'>,
    input: FinishRunnerCheckInput,
    at: string,
    ipCountry: string | null,
  ): Promise<boolean> {
    const reason = input.result === 'failed' ? input.reason : null;
    const claudeVersion = input.result === 'passed' ? input.claudeVersion : null;
    const [update] = await this.db.batch([
      ...auditedWrite(
        this.db,
        this.db
          .prepare(
            `UPDATE runner_checks SET state = ?4, reason = ?5, claude_version = ?6, duration_ms = ?7, finished_at = ?8
             WHERE id = ?1 AND runner_id = ?2 AND account_id = ?3 AND state = 'running'
               AND julianday(picked_at) > julianday(?8, '-${String(RUNNER_CHECK_RUNNING_SECONDS)} seconds')`,
          )
          .bind(
            check.id,
            check.runnerId,
            check.accountId,
            input.result,
            reason,
            claudeVersion,
            input.durationMs,
            at,
          ),
        {
          accountId: check.accountId,
          at,
          actorKind: 'runner',
          actor: check.runnerId,
          kind: 'runner.check-finished',
          target: check.runnerId,
          details: { checkId: check.id, kind: check.kind, result: input.result, reason, claudeVersion },
          ipCountry,
        },
      ),
    ]);
    return (update?.meta.changes ?? 0) === 1;
  }
}
