import type { JobDispatch, JobEventInput, JobKind, JobState, RunnerPolicy } from '@shared/contracts';
import { JOB_EVENTS_MAX_PER_JOB, JOB_MAX_ATTEMPTS, RUNNER_POLICY_OFFLINE_DEFAULT_SECONDS } from '@shared/contracts';
import { redactSecrets } from '@shared/redaction';
import { auditEventStatement, type AuditCondition, type NewAuditEvent } from '../accounts/audit.repo';
import { isConstraintError } from '../tracker/constraint-error';

/**
 * The job queue (#467, ADR 0006 "Runner and job queue", ADR 0008 decisions 2 and 12, migration 0022). The claim is
 * one UPDATE whose subquery holds every admission rule — the runner's account, its allowed projects, the team pause,
 * the placement policy, `needs_local` — so two runners racing never take one job and a runner never takes another
 * account's (threat model C9, C11). D1 keeps the SHA-256 of a job token, never the token.
 */

export interface JobRecord {
  readonly id: string;
  readonly accountId: string;
  readonly projectSlug: string;
  readonly kind: JobKind;
  readonly role: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly priority: number;
  readonly state: JobState;
  readonly requestedBy: string;
  readonly dedupeKey: string | null;
  readonly needsLocal: boolean;
  readonly parentJobId: string | null;
  readonly dispatch: JobDispatch;
  readonly runnerId: string | null;
  readonly attempt: number;
  readonly maxMinutes: number;
  readonly createdAt: string;
  readonly claimedAt: string | null;
  readonly leaseUntil: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly result: Readonly<Record<string, unknown>> | null;
}

export interface NewJob {
  readonly id: string;
  readonly accountId: string;
  readonly projectSlug: string;
  readonly kind: JobKind;
  readonly role: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly priority: number;
  readonly requestedBy: string;
  readonly dedupeKey: string | null;
  readonly needsLocal: boolean;
  readonly maxMinutes: number;
  readonly at: string;
}

export interface ClaimRequest {
  readonly runnerId: string;
  readonly accountId: string;
  readonly allowedProjects: readonly string[];
  readonly local: boolean;
  readonly tokenHash: string;
  readonly now: string;
  readonly leaseUntil: string;
}

export interface JobEventRecord {
  readonly seq: number;
  readonly at: string;
  readonly level: JobEventInput['level'];
  readonly kind: JobEventInput['kind'];
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface JobFilter {
  readonly state?: JobState;
  readonly after?: string | null;
  readonly limit: number;
}

interface JobRow {
  id: string;
  account_id: string;
  project_slug: string;
  kind: JobKind;
  role: string;
  payload: string;
  priority: number;
  state: JobState;
  requested_by: string;
  dedupe_key: string | null;
  needs_local: number;
  parent_job_id: string | null;
  dispatch: JobDispatch;
  runner_id: string | null;
  attempt: number;
  max_minutes: number;
  created_at: string;
  claimed_at: string | null;
  lease_until: string | null;
  started_at: string | null;
  finished_at: string | null;
  result: string | null;
}

const COLUMNS = `id, account_id, project_slug, kind, role, payload, priority, state, requested_by, dedupe_key, needs_local,
  parent_job_id, dispatch, runner_id, attempt, max_minutes, created_at, claimed_at, lease_until, started_at, finished_at, result`;

/** The policy the claim applies: the project's, else the account's default (ADR 0008 decision 12). */
const POLICY = `COALESCE(p.runner_policy, a.default_runner_policy)`;

function toRecord(row: JobRow): JobRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    projectSlug: row.project_slug,
    kind: row.kind,
    role: row.role,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    priority: row.priority,
    state: row.state,
    requestedBy: row.requested_by,
    dedupeKey: row.dedupe_key,
    needsLocal: row.needs_local === 1,
    parentJobId: row.parent_job_id,
    dispatch: row.dispatch,
    runnerId: row.runner_id,
    attempt: row.attempt,
    maxMinutes: row.max_minutes,
    createdAt: row.created_at,
    claimedAt: row.claimed_at,
    leaseUntil: row.lease_until,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    result: row.result === null ? null : (JSON.parse(row.result) as Record<string, unknown>),
  };
}

/** Every string in an event payload through the shared list (loose), before an append-only row takes it. */
function redactedPayload(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return redactSecrets(value, 'loose');
  }
  if (value === null || typeof value !== 'object' || depth >= 8) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactedPayload(item, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redactedPayload(item, depth + 1)]),
  );
}

export function effectivePolicyOf(projectPolicy: string | null, accountPolicy: string | null): RunnerPolicy {
  const json = projectPolicy ?? accountPolicy;
  return json === null ? { mode: 'any' } : (JSON.parse(json) as RunnerPolicy);
}

export class JobsRepo {
  /** `eventsCap`: the per-job run-log cap; the default is the product's, a spec lowers it to reach the cap path. */
  constructor(
    private readonly db: D1Database,
    private readonly eventsCap: number = JOB_EVENTS_MAX_PER_JOB,
  ) {}

  /** `job-exists` when a live job holds the dedupe key (the 0022 partial unique index), nothing written then. */
  async enqueue(job: NewJob, audit: NewAuditEvent): Promise<'ok' | 'job-exists'> {
    try {
      await this.db.batch([
        this.db
          .prepare(
            `INSERT INTO jobs (id, account_id, project_slug, kind, role, payload, priority, requested_by, dedupe_key, needs_local, max_minutes, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
          )
          .bind(
            job.id,
            job.accountId,
            job.projectSlug,
            job.kind,
            job.role,
            JSON.stringify(job.payload),
            job.priority,
            job.requestedBy,
            job.dedupeKey,
            job.needsLocal ? 1 : 0,
            job.maxMinutes,
            job.at,
          ),
        auditEventStatement(this.db, audit),
      ]);
    } catch (error: unknown) {
      if (isConstraintError(error, 'UNIQUE constraint failed: jobs.dedupe_key')) {
        return 'job-exists';
      }
      throw error;
    }
    return 'ok';
  }

  async findById(id: string): Promise<JobRecord | null> {
    const row = await this.db.prepare(`SELECT ${COLUMNS} FROM jobs WHERE id = ?1`).bind(id).first<JobRow>();
    return row === null ? null : toRecord(row);
  }

  /** A job of the project: another project's job is `null`, as one that does not exist. */
  async findInProject(projectSlug: string, id: string): Promise<JobRecord | null> {
    const row = await this.db
      .prepare(`SELECT ${COLUMNS} FROM jobs WHERE id = ?1 AND project_slug = ?2`)
      .bind(id, projectSlug)
      .first<JobRow>();
    return row === null ? null : toRecord(row);
  }

  async findByTokenHash(tokenHash: string): Promise<JobRecord | null> {
    const row = await this.db
      .prepare(`SELECT ${COLUMNS} FROM jobs WHERE token_hash = ?1`)
      .bind(tokenHash)
      .first<JobRow>();
    return row === null ? null : toRecord(row);
  }

  /** Newest first, cursor by id (ULIDs sort by time), at most `limit + 1` so the caller sees the next page. */
  async listForProject(projectSlug: string, filter: JobFilter): Promise<JobRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${COLUMNS} FROM jobs WHERE project_slug = ?1 AND (?2 IS NULL OR state = ?2) AND (?3 IS NULL OR id < ?3)
         ORDER BY id DESC LIMIT ?4`,
      )
      .bind(projectSlug, filter.state ?? null, filter.after ?? null, filter.limit + 1)
      .all<JobRow>();
    return results.map(toRecord);
  }

  /**
   * Lapsed leases first (ADR 0006 "Run"): a job whose runner stopped heartbeating goes back to the queue once, with a
   * `notice`; lost again it is `lost` for good and counts in the project's failure streak. Returns the lost ones so
   * the caller can record the streak.
   */
  async requeueLapsed(now: string): Promise<{ readonly requeued: string[]; readonly lost: JobRecord[] }> {
    const { results } = await this.db
      .prepare(
        `UPDATE jobs SET
           state = CASE WHEN attempt >= ?2 THEN 'lost' ELSE 'queued' END,
           runner_id = NULL, token_hash = NULL, lease_until = NULL,
           finished_at = CASE WHEN attempt >= ?2 THEN ?1 ELSE NULL END,
           result = CASE WHEN attempt >= ?2 THEN '{"reason":"lost"}' ELSE NULL END
         WHERE state IN ('claimed', 'running') AND lease_until < ?1
         RETURNING ${COLUMNS}`,
      )
      .bind(now, JOB_MAX_ATTEMPTS)
      .all<JobRow>();
    const rows = results.map(toRecord);
    const lost = rows.filter((row) => row.state === 'lost');
    const requeued = rows.filter((row) => row.state === 'queued').map((row) => row.id);
    if (rows.length > 0) {
      await this.db.batch(
        rows.map((row) =>
          this.eventStatement(row.id, now, {
            level: 'warn',
            kind: row.state === 'lost' ? 'failed' : 'notice',
            payload: { reason: 'lease-lapsed', attempt: row.attempt },
          }),
        ),
      );
    }
    return { requeued, lost };
  }

  /**
   * The atomic claim (ADR 0006 "Claim", ADR 0008 decision 12). Inside the one statement: the job is queued and
   * pulled, of the runner's account, of a project in the runner's allow-list, not of a suspended account, an
   * archived or paused project, not `needs_local` for a remote runner, and the placement policy admits this runner
   * now — `any`; `pinned` to it; `failover` as the preferred, or as a fallback while the preferred is revoked or
   * silent past `offline_after_seconds`. Highest priority, then oldest.
   */
  async claim(request: ClaimRequest): Promise<JobRecord | null> {
    const row = await this.db
      .prepare(
        `UPDATE jobs SET state = 'claimed', runner_id = ?1, claimed_at = ?2, lease_until = ?3, token_hash = ?4,
           attempt = attempt + 1
         WHERE state = 'queued' AND id = (
           SELECT j.id FROM jobs j
           JOIN projects p ON p.slug = j.project_slug
           JOIN accounts a ON a.id = j.account_id
           LEFT JOIN team_state t ON t.project_slug = j.project_slug
           WHERE j.state = 'queued' AND j.dispatch = 'pull'
             AND j.account_id = ?5
             AND a.suspended_at IS NULL AND p.archived_at IS NULL
             AND j.project_slug IN (SELECT value FROM json_each(?6))
             AND (j.needs_local = 0 OR ?7 = 1)
             AND t.paused_at IS NULL
             AND (
               ${POLICY} IS NULL
               OR json_extract(${POLICY}, '$.mode') = 'any'
               OR (json_extract(${POLICY}, '$.mode') = 'pinned' AND json_extract(${POLICY}, '$.runner') = ?1)
               OR (json_extract(${POLICY}, '$.mode') = 'failover' AND (
                    json_extract(${POLICY}, '$.preferred') = ?1
                    OR (?1 IN (SELECT value FROM json_each(${POLICY}, '$.fallback'))
                        AND NOT EXISTS (
                          SELECT 1 FROM runners pr
                          WHERE pr.id = json_extract(${POLICY}, '$.preferred') AND pr.revoked_at IS NULL
                            AND pr.last_seen_at IS NOT NULL
                            AND (julianday(?2) - julianday(pr.last_seen_at)) * 86400.0
                                < COALESCE(json_extract(${POLICY}, '$.offline_after_seconds'), ?8)))
               ))
             )
           ORDER BY j.priority DESC, j.created_at ASC, j.id ASC
           LIMIT 1
         )
         RETURNING ${COLUMNS}`,
      )
      .bind(
        request.runnerId,
        request.now,
        request.leaseUntil,
        request.tokenHash,
        request.accountId,
        JSON.stringify(request.allowedProjects),
        request.local ? 1 : 0,
        RUNNER_POLICY_OFFLINE_DEFAULT_SECONDS,
      )
      .first<JobRow>();
    return row === null ? null : toRecord(row);
  }

  /** Extends the lease of a job this runner holds; `false` when it holds no such live job. */
  async heartbeat(id: string, runnerId: string, now: string, leaseUntil: string): Promise<boolean> {
    const { meta } = await this.db
      .prepare(
        `UPDATE jobs SET lease_until = ?4 WHERE id = ?1 AND runner_id = ?2 AND state IN ('claimed', 'running') AND lease_until >= ?3`,
      )
      .bind(id, runnerId, now, leaseUntil)
      .run();
    return meta.changes === 1;
  }

  /** `onlyIf`: as for the audit row, the event is written only when the condition holds inside the batch (#492). */
  private eventStatement(jobId: string, at: string, event: JobEventInput, onlyIf?: AuditCondition): D1PreparedStatement {
    // The cap is judged inside the insert, so a flood past it writes nothing (threat model C2, D1 write budget).
    return this.db
      .prepare(
        `INSERT INTO job_events (job_id, seq, at, level, kind, payload)
         SELECT ?1, COALESCE((SELECT MAX(seq) FROM job_events WHERE job_id = ?1), 0) + 1, ?2, ?3, ?4, ?5
         WHERE (SELECT COUNT(*) FROM job_events WHERE job_id = ?1) < ?6${onlyIf === undefined ? '' : ` AND EXISTS (${onlyIf.exists})`}`,
      )
      .bind(
        jobId,
        at,
        event.level,
        event.kind,
        JSON.stringify(redactedPayload(event.payload)),
        this.eventsCap,
        ...(onlyIf?.params ?? []),
      );
  }

  /**
   * Appends a batch of events (redacted), numbered after the last; a `started` event also marks the job running.
   * Returns the last `seq` and whether the cap cut the batch.
   */
  async appendEvents(
    id: string,
    events: readonly JobEventInput[],
    now: string,
  ): Promise<{ readonly lastSeq: number; readonly capped: boolean }> {
    const statements = events.map((event) => this.eventStatement(id, now, event));
    if (events.some((event) => event.kind === 'started')) {
      statements.push(
        this.db
          .prepare(`UPDATE jobs SET state = 'running', started_at = COALESCE(started_at, ?2) WHERE id = ?1 AND state = 'claimed'`)
          .bind(id, now),
      );
    }
    const results = await this.db.batch(statements);
    const written = results.slice(0, events.length).filter((result) => result.meta.changes === 1).length;
    const last = await this.db
      .prepare(`SELECT COALESCE(MAX(seq), 0) AS seq FROM job_events WHERE job_id = ?1`)
      .bind(id)
      .first<{ seq: number }>();
    return { lastSeq: last?.seq ?? 0, capped: written < events.length };
  }

  async listEvents(id: string, after: number, limit: number): Promise<JobEventRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT seq, at, level, kind, payload FROM job_events WHERE job_id = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3`,
      )
      .bind(id, after, limit + 1)
      .all<{ seq: number; at: string; level: JobEventInput['level']; kind: JobEventInput['kind']; payload: string }>();
    return results.map((row) => ({ ...row, payload: JSON.parse(row.payload) as Record<string, unknown> }));
  }

  /** Finishes a job this runner holds, with its `finished`/`failed` event and the audit row; `false` when it holds none. */
  async finish(
    id: string,
    runnerId: string,
    outcome: { readonly result: 'finished' | 'failed'; readonly summary: string; readonly metrics: Readonly<Record<string, unknown>>; readonly acted: boolean },
    now: string,
    audit: NewAuditEvent,
  ): Promise<boolean> {
    const result = redactedPayload({ summary: outcome.summary, metrics: outcome.metrics, acted: outcome.acted });
    // One batch (#492): the event and the audit row are written only if the guarded UPDATE took, so a lapsed lease or
    // another runner's call writes nothing that reads as a finish (#490 review), and a failure between two calls can
    // no longer leave a finished job without its audit row.
    const finished: AuditCondition = {
      exists: `SELECT 1 FROM jobs WHERE id = ? AND runner_id = ? AND state = ? AND finished_at = ?`,
      params: [id, runnerId, outcome.result, now],
    };
    const [update] = await this.db.batch([
      this.db
        .prepare(
          `UPDATE jobs SET state = ?3, finished_at = ?4, result = ?5, token_hash = NULL, lease_until = NULL
           WHERE id = ?1 AND runner_id = ?2 AND state IN ('claimed', 'running') AND lease_until >= ?4`,
        )
        .bind(id, runnerId, outcome.result, now, JSON.stringify(result)),
      this.eventStatement(
        id,
        now,
        {
          level: outcome.result === 'failed' ? 'error' : 'info',
          kind: outcome.result,
          payload: { summary: outcome.summary, acted: outcome.acted },
        },
        finished,
      ),
      auditEventStatement(this.db, audit, finished),
    ]);
    return update?.meta.changes === 1;
  }

  /** The statements that cancel this runner's live jobs outside `slugs`, for the allow-list write's batch (#490 review). */
  cancelOutsideStatements(runnerId: string, slugs: readonly string[], now: string): D1PreparedStatement[] {
    return [
      this.db
        .prepare(
          `UPDATE jobs SET state = 'cancelled', finished_at = ?2, result = '{"reason":"runner-allow-list"}', token_hash = NULL, lease_until = NULL
           WHERE runner_id = ?1 AND state IN ('claimed', 'running') AND project_slug NOT IN (SELECT value FROM json_each(?3))`,
        )
        .bind(runnerId, now, JSON.stringify(slugs)),
    ];
  }

  /** The statements that cancel a runner's live jobs, for the revoke batch (ADR 0006: revoking cancels claimed jobs). */
  cancelForRunnerStatements(runnerId: string, now: string): D1PreparedStatement[] {
    return [
      this.db
        .prepare(
          `UPDATE jobs SET state = 'cancelled', finished_at = ?2, result = '{"reason":"runner-revoked"}', token_hash = NULL, lease_until = NULL
           WHERE runner_id = ?1 AND state IN ('claimed', 'running')`,
        )
        .bind(runnerId, now),
    ];
  }
}
