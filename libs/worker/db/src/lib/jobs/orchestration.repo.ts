import { ORCHESTRATE_MAX_STEPS, type JobState, type OrchestrationChildCounts } from '@shared/contracts';
import {
  AUDITED_WRITE_HAPPENED_SQL,
  auditEventStatement,
  auditedWrite,
  type NewAuditEvent,
} from '../accounts/audit.repo';
import {
  JOB_COLUMNS,
  JOB_INSERT_EXTRA_FIRST,
  enqueueOutcomeOf,
  jobInsertStatement,
  jobRecordOf,
  type EnqueueOutcome,
  type JobRecord,
  type JobRow,
  type NewJob,
} from './jobs.repo';

/**
 * Console-driven orchestration (#1039, ADR 0010 decisions 1–3, migration 0045): the run lock in `team_state` and the
 * job writes that move with it, each in one batch so a run and its jobs never disagree. The only writer of
 * `team_state.orchestrate_run_id` and `orchestrate_steps`. The claim is untouched: a step and a child are ordinary jobs,
 * and one live orchestrator per project is the 0022 dedupe index (`<slug>:orchestrator`), not a claim term.
 */

const LIVE = `('queued', 'claimed', 'running')`;

/**
 * The jobs of run `?2` in project `?1`: its steps and children carry `payload.run`; a `review` job a step requested
 * (#612) carries none, so it belongs to the run through its parent.
 */
const OF_RUN = `project_slug = ?1 AND (json_extract(payload, '$.run') = ?2
  OR parent_job_id IN (SELECT id FROM jobs WHERE project_slug = ?1 AND json_extract(payload, '$.run') = ?2))`;

/** The live run's row is still `runId` (placeholders numbered from the insert's first extra one). */
const RUN_HOLDS = `EXISTS (SELECT 1 FROM team_state WHERE project_slug = ?3 AND orchestrate_run_id = ?${String(JOB_INSERT_EXTRA_FIRST)})`;

/** Under the step cap too: `orchestrate_steps` counts the steps already enqueued. */
const RUN_HOLDS_UNDER_CAP = `EXISTS (SELECT 1 FROM team_state WHERE project_slug = ?3
  AND orchestrate_run_id = ?${String(JOB_INSERT_EXTRA_FIRST)} AND orchestrate_steps < ?${String(JOB_INSERT_EXTRA_FIRST + 1)})`;

/** Why a job ended without its runner's finish, as `result.reason` records it. */
export type JobCancelReason = 'orchestration-stopped' | 'owner-cancelled' | 'parent-cancelled';

const cancelledResult = (reason: JobCancelReason): string => JSON.stringify({ reason });

/**
 * A cancel as every cancel of the queue writes it (`cancelForRunnerStatements`): the job leaves the live states, so
 * 0022's CHECK no longer asks for a runner, a lease and a token, and the token dies in the same statement.
 */
const CANCEL_SET = `state = 'cancelled', finished_at = ?3, result = ?4, token_hash = NULL, lease_until = NULL`;

export type StartOutcome = 'started' | 'orchestration-active' | Exclude<EnqueueOutcome, 'ok'>;
export type WakeOutcome = 'enqueued' | 'run-moved' | Exclude<EnqueueOutcome, 'ok'>;

export interface ChildrenFilter {
  readonly state?: JobState;
  /** The last child id of the previous page (children are listed oldest first). */
  readonly after?: string | null;
  readonly limit: number;
}

export class OrchestrationRepo {
  constructor(private readonly db: D1Database) {}

  /**
   * Takes the lock where it is free and enqueues the run's first step, all or nothing: the lock and its
   * `orchestration.started` row, then the step only while the lock is this run's, then the step's own audit row. A taken
   * lock writes nothing; a live orchestrator job holding `<slug>:orchestrator` fails the batch as a whole.
   */
  startStatements(
    projectSlug: string,
    runId: string,
    firstStep: NewJob,
    startAudit: NewAuditEvent,
    stepAudit: NewAuditEvent,
  ): D1PreparedStatement[] {
    return [
      ...auditedWrite(
        this.db,
        this.db
          .prepare(
            `INSERT INTO team_state (project_slug, failed_streak, updated_at, orchestrate_run_id, orchestrate_steps)
             VALUES (?1, 0, ?2, ?3, 1)
             ON CONFLICT (project_slug) DO UPDATE SET orchestrate_run_id = excluded.orchestrate_run_id,
               orchestrate_steps = 1, updated_at = excluded.updated_at
             WHERE team_state.orchestrate_run_id IS NULL`,
          )
          .bind(projectSlug, firstStep.at, runId),
        startAudit,
      ),
      jobInsertStatement(this.db, firstStep, { where: RUN_HOLDS, extra: [runId] }),
      auditEventStatement(this.db, stepAudit, {
        exists: 'SELECT 1 FROM jobs WHERE id = ?',
        params: [firstStep.id],
      }),
    ];
  }

  async start(
    projectSlug: string,
    runId: string,
    firstStep: NewJob,
    startAudit: NewAuditEvent,
    stepAudit: NewAuditEvent,
  ): Promise<StartOutcome> {
    let locked = false;
    const outcome = await enqueueOutcomeOf(async () => {
      const [lock] = await this.db.batch(
        this.startStatements(projectSlug, runId, firstStep, startAudit, stepAudit),
      );
      locked = (lock?.meta.changes ?? 0) === 1;
    });
    if (outcome !== 'ok') {
      return outcome;
    }
    return locked ? 'started' : 'orchestration-active';
  }

  /**
   * Stop (a hard cancel, owner decision 2026-11-26): clears the run and, only when that took, cancels every queued,
   * claimed or running job of it in the same batch — its token cleared, `result.reason = orchestration-stopped`.
   * `AUDITED_WRITE_HAPPENED_SQL` reads the `orchestration.stopped` row, so the cancel must follow the pair directly.
   */
  stopStatements(
    projectSlug: string,
    runId: string,
    now: string,
    audit: NewAuditEvent,
  ): D1PreparedStatement[] {
    return [
      ...this.endStatements(projectSlug, runId, now, audit),
      this.db
        .prepare(
          `UPDATE jobs SET ${CANCEL_SET} WHERE ${OF_RUN} AND state IN ${LIVE} AND ${AUDITED_WRITE_HAPPENED_SQL}`,
        )
        .bind(projectSlug, runId, now, cancelledResult('orchestration-stopped')),
    ];
  }

  /** `stopped: false` when the run was no longer `runId` (ended or stopped since the read); nothing written then. */
  async stop(
    projectSlug: string,
    runId: string,
    now: string,
    audit: NewAuditEvent,
  ): Promise<{ readonly stopped: boolean; readonly cancelled: number }> {
    const [cleared, , cancel] = await this.db.batch(this.stopStatements(projectSlug, runId, now, audit));
    return { stopped: (cleared?.meta.changes ?? 0) === 1, cancelled: cancel?.meta.changes ?? 0 };
  }

  /** The run ends (`done`, the step cap, or Stop): the lock is cleared and the step count reset, with its audit row. */
  endStatements(
    projectSlug: string,
    runId: string,
    now: string,
    audit: NewAuditEvent,
  ): readonly [D1PreparedStatement, D1PreparedStatement] {
    return auditedWrite(
      this.db,
      this.db
        .prepare(
          `UPDATE team_state SET orchestrate_run_id = NULL, orchestrate_steps = 0, updated_at = ?3
           WHERE project_slug = ?1 AND orchestrate_run_id = ?2`,
        )
        .bind(projectSlug, runId, now),
      audit,
    );
  }

  async end(projectSlug: string, runId: string, now: string, audit: NewAuditEvent): Promise<boolean> {
    const [cleared] = await this.db.batch([...this.endStatements(projectSlug, runId, now, audit)]);
    return (cleared?.meta.changes ?? 0) === 1;
  }

  /**
   * The next step of a run: inserted only while the run is still `runId` and under `ORCHESTRATE_MAX_STEPS`, its audit
   * row only when the insert took (`auditedWrite`), and the step count raised only when that row was written, directly
   * after the pair. Two wakes racing meet at the dedupe index: the loser's batch fails whole, its count included.
   */
  wakeStatements(
    projectSlug: string,
    runId: string,
    step: NewJob,
    audit: NewAuditEvent,
  ): D1PreparedStatement[] {
    return [
      ...auditedWrite(
        this.db,
        jobInsertStatement(this.db, step, {
          where: RUN_HOLDS_UNDER_CAP,
          extra: [runId, ORCHESTRATE_MAX_STEPS],
        }),
        audit,
      ),
      this.db
        .prepare(
          `UPDATE team_state SET orchestrate_steps = orchestrate_steps + 1, updated_at = ?3
           WHERE project_slug = ?1 AND orchestrate_run_id = ?2 AND ${AUDITED_WRITE_HAPPENED_SQL}`,
        )
        .bind(projectSlug, runId, step.at),
    ];
  }

  async wake(projectSlug: string, runId: string, step: NewJob, audit: NewAuditEvent): Promise<WakeOutcome> {
    let inserted = false;
    const outcome = await enqueueOutcomeOf(async () => {
      const [insert] = await this.db.batch(this.wakeStatements(projectSlug, runId, step, audit));
      inserted = (insert?.meta.changes ?? 0) === 1;
    });
    if (outcome !== 'ok') {
      return outcome;
    }
    return inserted ? 'enqueued' : 'run-moved';
  }

  /**
   * The owner's cancel of one live job (#1039): its token dies in the statement, and its queued children are cancelled
   * with it, only when the cancel took (the `job.cancelled` row is the statement before). A claimed or running child
   * keeps going: it holds its own token and lease, and the owner cancels it by its own id.
   */
  cancelStatements(
    projectSlug: string,
    jobId: string,
    now: string,
    audit: NewAuditEvent,
  ): D1PreparedStatement[] {
    return [
      ...auditedWrite(
        this.db,
        this.db
          .prepare(`UPDATE jobs SET ${CANCEL_SET} WHERE project_slug = ?1 AND id = ?2 AND state IN ${LIVE}`)
          .bind(projectSlug, jobId, now, cancelledResult('owner-cancelled')),
        audit,
      ),
      this.db
        .prepare(
          `UPDATE jobs SET ${CANCEL_SET}
           WHERE project_slug = ?1 AND parent_job_id = ?2 AND state = 'queued' AND ${AUDITED_WRITE_HAPPENED_SQL}`,
        )
        .bind(projectSlug, jobId, now, cancelledResult('parent-cancelled')),
    ];
  }

  /** `cancelled: false` when the job was not live (finished, or another cancel won); nothing written then. */
  async cancel(
    projectSlug: string,
    jobId: string,
    now: string,
    audit: NewAuditEvent,
  ): Promise<{ readonly cancelled: boolean; readonly children: number }> {
    const [job, , children] = await this.db.batch(this.cancelStatements(projectSlug, jobId, now, audit));
    return { cancelled: (job?.meta.changes ?? 0) === 1, children: children?.meta.changes ?? 0 };
  }

  /** The queued, claimed or running jobs of the run (steps, children and the reviews its steps asked for). */
  async liveOfRun(projectSlug: string, runId: string): Promise<JobRecord[]> {
    const { results } = await this.db
      .prepare(`SELECT ${JOB_COLUMNS} FROM jobs WHERE ${OF_RUN} AND state IN ${LIVE} ORDER BY id`)
      .bind(projectSlug, runId)
      .all<JobRow>();
    return results.map(jobRecordOf);
  }

  /** The run's newest step, live or ended; `null` before its first. */
  async lastStepOf(projectSlug: string, runId: string): Promise<JobRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT ${JOB_COLUMNS} FROM jobs
         WHERE project_slug = ?1 AND kind = 'orchestrate' AND json_extract(payload, '$.run') = ?2
         ORDER BY id DESC LIMIT 1`,
      )
      .bind(projectSlug, runId)
      .first<JobRow>();
    return row === null ? null : jobRecordOf(row);
  }

  /** The run's `task` children by state (`running` with claimed, `failed` with lost and cancelled). */
  async childCountsOf(projectSlug: string, runId: string): Promise<OrchestrationChildCounts> {
    const row = await this.db
      .prepare(
        `SELECT COALESCE(SUM(state = 'queued'), 0) AS queued,
           COALESCE(SUM(state IN ('claimed', 'running')), 0) AS running,
           COALESCE(SUM(state = 'finished'), 0) AS finished,
           COALESCE(SUM(state IN ('failed', 'lost', 'cancelled')), 0) AS failed
         FROM jobs WHERE project_slug = ?1 AND kind = 'task' AND json_extract(payload, '$.run') = ?2`,
      )
      .bind(projectSlug, runId)
      .first<OrchestrationChildCounts>();
    return row ?? { queued: 0, running: 0, finished: 0, failed: 0 };
  }

  /** A job's children in its project, oldest first, at most `limit + 1` so the caller sees the next page. */
  async childrenOf(projectSlug: string, parentId: string, filter: ChildrenFilter): Promise<JobRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${JOB_COLUMNS} FROM jobs
         WHERE project_slug = ?1 AND parent_job_id = ?2 AND (?3 IS NULL OR state = ?3) AND (?4 IS NULL OR id > ?4)
         ORDER BY id LIMIT ?5`,
      )
      .bind(projectSlug, parentId, filter.state ?? null, filter.after ?? null, filter.limit + 1)
      .all<JobRow>();
    return results.map(jobRecordOf);
  }
}
