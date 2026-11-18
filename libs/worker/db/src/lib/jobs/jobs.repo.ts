import type {
  Ed25519PublicJwk,
  JobDispatch,
  JobEventInput,
  JobKind,
  JobState,
  RunnerHostDto,
  RunnerPolicy,
} from '@shared/contracts';
import {
  BUDGET_PAUSER,
  JOB_EVENTS_MAX_PER_JOB,
  JOB_MAX_ATTEMPTS,
  RUNNER_POLICY_OFFLINE_DEFAULT_SECONDS,
} from '@shared/contracts';
import {
  ROLE_ADMITTED_SQL,
  accountInFlightBelowSql,
  budgetAdmittedSql,
  entitledConcurrencyAdmittedSql,
  entitledConcurrencyOf,
  entitledConcurrencyParams,
  roleAdmissionParams,
  roleAdmittedSql,
  type EntitledConcurrency,
} from '../team-config/claim-admission';
import { redactSecrets } from '@shared/redaction';
import {
  AUDITED_WRITE_HAPPENED_SQL,
  auditEventStatement,
  auditedWrite,
  type AuditCondition,
  type NewAuditEvent,
} from '../accounts/audit.repo';
import { claimPlacementAdmitsSql, runnerFitsAccessSourceSql, runnerServesSql } from '../team-config/access-source';
import { isConstraintError } from '../tracker/constraint-error';

/**
 * The job queue (#467, ADR 0006 "Runner and job queue", ADR 0008 decisions 2 and 12, migration 0022). The claim is
 * one UPDATE whose subquery holds every admission rule — the runner's account, its allowed projects, the team pause,
 * the placement policy, `needs_local`, the account's entitled concurrency (#746) — so two runners racing never take one
 * job, nor the account's last slot twice, and a runner never takes another account's (threat model C9, C11). D1
 * keeps the SHA-256 of a job token, never the token.
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
  /** The team-config revision the claim stamped (ADR 0009 d.7); `null` before a claim or for a project without one. */
  readonly teamConfigRevision: number | null;
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
  /** The job that asked for this one (lineage, ADR 0006 R2); from the requester's identity, never a body. */
  readonly parentJobId?: string | null;
}

export interface ClaimRequest {
  readonly runnerId: string;
  readonly accountId: string;
  readonly local: boolean;
  readonly tokenHash: string;
  readonly now: string;
  readonly leaseUntil: string;
}

/** The project a dispatched job's run must come from (#668): what the OIDC claims are compared with. */
export interface ActionsTargetRecord {
  readonly job: JobRecord;
  readonly repoId: number | null;
  readonly repo: string;
  readonly defaultBranch: string | null;
  /**
   * The workflow run the console's dispatch started for the job (#723 item 2): GitHub names it in its answer and the
   * dispatch records it before any run can exchange. `null` before that; the exchange takes the job for no other run.
   */
  readonly dispatchedRunId: string | null;
}

/** The OIDC exchange's write (#668): an ephemeral runner for one job, and that job claimed for it. */
export interface ActionsExchange {
  readonly jobId: string;
  readonly runId: string;
  readonly runnerId: string;
  readonly runnerName: string;
  readonly publicKeyJwk: Ed25519PublicJwk;
  readonly host: RunnerHostDto;
  readonly version: string;
  readonly tokenHash: string;
  readonly now: string;
  readonly leaseUntil: string;
  readonly country: string | null;
  readonly ipHash: string | null;
  readonly enrolledAudit: NewAuditEvent;
  readonly claimedAudit: NewAuditEvent;
}

export type ActionsExchangeOutcome =
  | { readonly kind: 'claimed'; readonly job: JobRecord }
  /** The job is no longer a queued, unclaimed Actions job of a live project (another exchange won it, or it ended). */
  | { readonly kind: 'not-claimable' }
  /** Another job already holds this `run_id` (0031's unique index). */
  | { readonly kind: 'run-seen' }
  /** The project runs on a `subscription` (ADR 0009 d.3, #682): no GitHub Actions machine may run its jobs. */
  | { readonly kind: 'access-source' };

export type EnqueueOutcome = 'ok' | 'job-exists' | 'access-source-hosted';

/** A project with queued jobs whose account is entitled to no concurrency at all (#746): none of them will start. */
export interface ConcurrencyStopRecord {
  readonly projectSlug: string;
  readonly queuedJobs: number;
}

/** Which undispatched Actions jobs `listDispatchable` looks at: one project's, one account's, or (empty) all. */
export interface DispatchScope {
  readonly projectSlug?: string | null;
  readonly accountId?: string | null;
}

/**
 * A queued Actions job with what its `workflow_dispatch` call needs (#670). `installationId` is the project's
 * installation only while it is linked to the project's own account (ADR 0008 decision 2), else `null`.
 */
export interface DispatchTargetRecord {
  readonly job: JobRecord;
  readonly repo: string;
  readonly repoId: number | null;
  readonly installationId: number | null;
  readonly defaultBranch: string | null;
  /**
   * Whether the exchange would take the job if its run came now (#722): account, project, pause, source, role and
   * budget. A read, so only a hint that saves GitHub calls; `markDispatched` judges the same terms in its write.
   */
  readonly admitted: boolean;
}

/** What `finish` reconciles into the month's spend (#684, ADR 0009 d.6). */
export interface FinishSpend {
  /** Dollars, already checked to lie in `[0, JOB_COST_USD_MAX]`; 0 when the runner reported none. */
  readonly costUsd: number;
  /** The `team.paused` row written when this finish is the one that stops the team on its budget. */
  readonly pauseAudit: NewAuditEvent;
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
  team_config_revision: number | null;
}

const COLUMNS = `id, account_id, project_slug, kind, role, payload, priority, state, requested_by, dedupe_key, needs_local,
  parent_job_id, dispatch, runner_id, attempt, max_minutes, created_at, claimed_at, lease_until, started_at, finished_at, result,
  team_config_revision`;
const PREFIXED_COLUMNS = COLUMNS.split(',')
  .map((column) => `j.${column.trim()}`)
  .join(', ');

/**
 * A WHERE term on a `jobs` row (#553): its runner's stored row still serves the job's project under its scope (#775,
 * `runnerServesSql`), inside the job's account, and is not revoked. The runner routes judge the scope read at
 * authentication; this term judges it again inside the write itself, so a narrowing or revoke that commits in between
 * wins, as it does for the claim (#543).
 */
export const RUNNER_STILL_ALLOWS_SQL = `EXISTS (
  SELECT 1 FROM runners r
  WHERE r.id = jobs.runner_id AND r.account_id = jobs.account_id AND r.revoked_at IS NULL
    AND ${runnerServesSql('r', 'jobs.project_slug')})`;

/**
 * A write made under a job token (#580): the job must still hold when its batch commits — the token's hash still
 * names it (a cancel, a finish or a narrowing batch clears it), it is live inside its lease, and its runner's stored
 * row still allows its project and is not revoked. Authentication judged a copy read at the start of the request;
 * this judges the rows the batch sees, so a narrowing or revoke that commits in between wins.
 */
export interface JobTokenHold {
  readonly tokenHash: string;
  readonly jobId: string;
  /** ISO time the lease is judged against. */
  readonly at: string;
}

/** The `EXISTS` body of a `JobTokenHold`, its three placeholders numbered from `first` (hash, job id, time). */
export function jobTokenHoldsSql(first: number): string {
  const [hash, id, at] = [first, first + 1, first + 2].map((n) => `?${String(n)}`);
  return `SELECT 1 FROM jobs WHERE jobs.token_hash = ${hash} AND jobs.id = ${id}
    AND jobs.state IN ('claimed', 'running') AND jobs.lease_until >= ${at} AND ${RUNNER_STILL_ALLOWS_SQL}`;
}

/** The policy the claim applies: the project's, else the account's default (ADR 0008 decision 12). */
const POLICY = `COALESCE(p.runner_policy, a.default_runner_policy)`;

/** The candidate `j` with every row the admission terms read: its project, account, team state and team config. */
const ADMISSION_FROM = `FROM jobs j JOIN projects p ON p.slug = j.project_slug JOIN accounts a ON a.id = j.account_id
  LEFT JOIN team_state t ON t.project_slug = j.project_slug
  LEFT JOIN team_configs tc ON tc.project_slug = j.project_slug`;

/** An Actions job the console has not asked GitHub to run yet. */
const UNDISPATCHED_SQL = `j.state = 'queued' AND j.dispatch = 'actions' AND j.dispatched_at IS NULL
  AND j.runner_id IS NULL AND j.needs_local = 0`;

/**
 * The exchange's admission, judged before a run is started for `j` (#722, #716): a live account and project, the team
 * not paused (any pauser, `system:budget` among them), an API-key project (ADR 0009 d.3), the role on and under its
 * `max_parallel` counting the runs already dispatched, the month's budget not used up, and the account under its
 * entitled concurrency (`concurrency`, a term of `claim-admission.ts`, #746). The exchange still judges its own terms in
 * its own write; this keeps a run that would be refused from being started at all.
 */
function dispatchAdmittedSql(presets: string, top: string, now: string, concurrency: string): string {
  return `a.suspended_at IS NULL AND p.archived_at IS NULL AND t.paused_at IS NULL AND p.access_source = 'api_key'
    AND ${roleAdmittedSql(presets, top, { countDispatched: true })} AND ${budgetAdmittedSql(now)} AND ${concurrency}`;
}

interface AccountEntitlementsRow {
  id: string;
  plan: string;
  entitlements: string;
}

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
    teamConfigRevision: row.team_config_revision,
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
  async enqueue(job: NewJob, audit: NewAuditEvent): Promise<EnqueueOutcome> {
    return this.enqueueAll([{ job, audit }]);
  }

  /**
   * All or none, in one batch: `job-exists` when any live job holds one of the dedupe keys, nothing written then.
   * With `hold` (a job asking under its token, #580) the batch fails as a whole unless that job still holds.
   *
   * A job takes its project's `dispatch` as the insert reads it (#670), so a switch that commits first decides; a
   * `needs_local` job stays `pull` on an Actions project, since only the owner's own runner may take it (#695).
   * `access-source-hosted` when 0032's trigger refuses an Actions job of a `subscription` project (#706).
   */
  async enqueueAll(
    entries: readonly { readonly job: NewJob; readonly audit: NewAuditEvent }[],
    hold?: JobTokenHold,
  ): Promise<EnqueueOutcome> {
    if (entries.length === 0) {
      return 'ok';
    }
    // A NULL account fails the insert (the account trigger, else NOT NULL), so the whole batch rolls back.
    const account = hold === undefined ? '?2' : `CASE WHEN EXISTS (${jobTokenHoldsSql(14)}) THEN ?2 ELSE NULL END`;
    const holdParams = hold === undefined ? [] : [hold.tokenHash, hold.jobId, hold.at];
    try {
      await this.db.batch(
        entries.flatMap(({ job, audit }) => [
          this.db
            .prepare(
              `INSERT INTO jobs (id, account_id, project_slug, kind, role, payload, priority, requested_by, dedupe_key, needs_local, max_minutes, created_at, parent_job_id, dispatch)
               VALUES (?1, ${account}, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                 CASE WHEN ?10 = 1 THEN 'pull' ELSE COALESCE((SELECT dispatch FROM projects WHERE slug = ?3), 'pull') END)`,
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
              job.parentJobId ?? null,
              ...holdParams,
            ),
          auditEventStatement(this.db, audit),
        ]),
      );
    } catch (error: unknown) {
      if (isConstraintError(error, 'UNIQUE constraint failed: jobs.dedupe_key')) {
        return 'job-exists';
      }
      if (isConstraintError(error, 'access-source-hosted:')) {
        return 'access-source-hosted';
      }
      throw error;
    }
    return 'ok';
  }

  /** The queued, claimed or running jobs of the project that hold one of `dedupeKeys`. */
  async findLiveByDedupeKeys(projectSlug: string, dedupeKeys: readonly string[]): Promise<JobRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${COLUMNS} FROM jobs WHERE project_slug = ?1 AND state IN ('queued', 'claimed', 'running')
           AND dedupe_key IN (SELECT value FROM json_each(?2))
         ORDER BY id`,
      )
      .bind(projectSlug, JSON.stringify(dedupeKeys))
      .all<JobRow>();
    return results.map(toRecord);
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
    const [, requeue] = await this.db.batch<JobRow>([
      // #668: an ephemeral Actions identity serves its one job; once that job holds no live lease (lapsed here, or
      // ended by a cancel) the identity is revoked, before the UPDATE below clears the job's `runner_id`.
      this.db
        .prepare(
          `UPDATE runners SET revoked_at = ?1
           WHERE isolation = 'actions-ephemeral' AND revoked_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM jobs WHERE jobs.runner_id = runners.id AND jobs.state IN ('claimed', 'running')
                 AND jobs.lease_until >= ?1)`,
        )
        .bind(now),
      // An Actions job is lost on its first lapse: its VM is gone and its run is spent (0031 keeps the run id), so
      // only a new dispatch could run it, never a requeue.
      this.db
        .prepare(
          `UPDATE jobs SET
             state = CASE WHEN attempt >= ?2 OR dispatch = 'actions' THEN 'lost' ELSE 'queued' END,
             runner_id = NULL, token_hash = NULL, lease_until = NULL,
             finished_at = CASE WHEN attempt >= ?2 OR dispatch = 'actions' THEN ?1 ELSE NULL END,
             result = CASE WHEN attempt >= ?2 OR dispatch = 'actions' THEN '{"reason":"lost"}' ELSE NULL END
           WHERE state IN ('claimed', 'running') AND lease_until < ?1
           RETURNING ${COLUMNS}`,
        )
        .bind(now, JOB_MAX_ATTEMPTS),
    ]);
    const rows = (requeue?.results ?? []).map(toRecord);
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
   * silent past `offline_after_seconds`. Highest priority, then oldest. The runner itself must not be paused (#571)
   * and must hold fewer live jobs than its `capabilities.maxConcurrency`, judged in this same statement so two polls
   * of one runner never both pass the count (threat model C4 "rogue runner").
   *
   * The allow-list and `revoked_at` are read from the stored runner row here, never taken from the caller: a
   * narrowing or revoke that commits between the poll's authentication and this claim must win (#543).
   *
   * Team configuration (ADR 0009, #687): a `subscription` project is pulled only by a self-hosted runner that is not
   * an `actions-ephemeral` one (d.3; `hosted` is 0 on those too, so it alone is not enough); a role switched off is not
   * claimed, and a role already holding its `max_parallel` live jobs on the project waits — both judged here, never by
   * a pre-read, so two concurrent claims never both pass the count. The claim stamps the current revision on the job,
   * so a change applies to the next claim and never to a job in flight. The role's dispatched, not yet exchanged
   * Actions jobs count against `max_parallel` as well (#716). A project whose UTC month's spend reached its
   * `budget.monthly_usd` is not claimed unless the owner waived it for the month (#684): judged here too, so a budget
   * lowered below the spend stops the next claim without waiting for a `finish`.
   *
   * The account's entitled concurrency (#746, ADR 0008 decision 6): its claimed and running jobs, with its dispatched
   * Actions jobs no run has exchanged yet, must stay below `entitlementsOf(account).maxConcurrency`, counted in this same
   * statement, so of two runners racing for the account's last slot one claims and the other gets nothing. The limit is
   * computed from the account row read just before, and the statement requires that row unchanged; `0` claims nothing.
   */
  async claim(request: ClaimRequest): Promise<JobRecord | null> {
    const entitled = await this.entitledConcurrencyOfAccount(request.accountId);
    if (entitled === null) {
      return null;
    }
    const row = await this.db
      .prepare(
        `UPDATE jobs SET state = 'claimed', runner_id = ?1, claimed_at = ?2, lease_until = ?3, token_hash = ?4,
           attempt = attempt + 1,
           team_config_revision = (SELECT revision FROM team_configs WHERE project_slug = jobs.project_slug)
         WHERE state = 'queued' AND id = (
           SELECT j.id FROM jobs j
           JOIN projects p ON p.slug = j.project_slug
           JOIN accounts a ON a.id = j.account_id
           LEFT JOIN team_state t ON t.project_slug = j.project_slug
           LEFT JOIN team_configs tc ON tc.project_slug = j.project_slug
           WHERE j.state = 'queued' AND j.dispatch = 'pull'
             AND j.account_id = ?5
             AND a.suspended_at IS NULL AND p.archived_at IS NULL
             AND EXISTS (
               SELECT 1 FROM runners r
               WHERE r.id = ?1 AND r.account_id = ?5 AND r.revoked_at IS NULL AND ${runnerServesSql('r', 'j.project_slug')})
             AND (j.needs_local = 0 OR ?6 = 1)
             AND t.paused_at IS NULL
             AND EXISTS (
               SELECT 1 FROM runners me
               WHERE me.id = ?1
                 AND (me.paused_until IS NULL OR julianday(me.paused_until) <= julianday(?2))
                 AND (SELECT COUNT(*) FROM jobs held WHERE held.runner_id = ?1 AND held.state IN ('claimed', 'running'))
                     < COALESCE(json_extract(me.capabilities, '$.maxConcurrency'), 1)
                 AND ${runnerFitsAccessSourceSql('me', 'p')})
             AND ${ROLE_ADMITTED_SQL}
             AND ${budgetAdmittedSql('?2')}
             AND ${entitledConcurrencyAdmittedSql('?10', '?11', '?12')}
             AND ${claimPlacementAdmitsSql(POLICY, '?1', '?2', '?7')}
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
        request.local ? 1 : 0,
        RUNNER_POLICY_OFFLINE_DEFAULT_SECONDS,
        ...roleAdmissionParams(),
        ...entitledConcurrencyParams(entitled),
      )
      .first<JobRow>();
    return row === null ? null : toRecord(row);
  }

  /**
   * Of `slugs`, the projects with queued jobs whose account `entitlementsOf` gives `maxConcurrency: 0` (#746): the
   * claim and the dispatch admit none of their jobs, so "Needs you" says why. One read, whatever the number of slugs.
   */
  async concurrencyStopsOf(slugs: readonly string[]): Promise<ConcurrencyStopRecord[]> {
    if (slugs.length === 0) {
      return [];
    }
    const { results } = await this.db
      .prepare(
        `SELECT p.slug, a.id, a.plan, a.entitlements,
           (SELECT COUNT(*) FROM jobs q WHERE q.project_slug = p.slug AND q.state = 'queued') AS queued
         FROM projects p JOIN accounts a ON a.id = p.account_id
         WHERE p.slug IN (SELECT value FROM json_each(?1))`,
      )
      .bind(JSON.stringify(slugs))
      .all<AccountEntitlementsRow & { slug: string; queued: number }>();
    return results
      .filter((row) => row.queued > 0 && entitledConcurrencyOf(row).limit === 0)
      .map((row) => ({ projectSlug: row.slug, queuedJobs: row.queued }));
  }

  /** The account's entitled concurrency as its row reads now; `null` when there is no such account. */
  private async entitledConcurrencyOfAccount(accountId: string): Promise<EntitledConcurrency | null> {
    const row = await this.db
      .prepare(`SELECT id, plan, entitlements FROM accounts WHERE id = ?1`)
      .bind(accountId)
      .first<AccountEntitlementsRow>();
    return row === null ? null : entitledConcurrencyOf(row);
  }

  /** The entitled concurrency of the job's account; `null` when the job does not exist. */
  private async entitledConcurrencyOfJob(jobId: string): Promise<EntitledConcurrency | null> {
    const row = await this.db
      .prepare(`SELECT a.id, a.plan, a.entitlements FROM jobs j JOIN accounts a ON a.id = j.account_id WHERE j.id = ?1`)
      .bind(jobId)
      .first<AccountEntitlementsRow>();
    return row === null ? null : entitledConcurrencyOf(row);
  }

  /** A job with the project fields its Actions run is verified against; `null` when the job does not exist. */
  async findActionsTarget(jobId: string): Promise<ActionsTargetRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT ${PREFIXED_COLUMNS}, p.repo_id AS project_repo_id, p.repo AS project_repo,
           p.default_branch AS project_default_branch, j.actions_run_id AS dispatched_run_id
         FROM jobs j JOIN projects p ON p.slug = j.project_slug WHERE j.id = ?1`,
      )
      .bind(jobId)
      .first<
        JobRow & {
          project_repo_id: number | null;
          project_repo: string;
          project_default_branch: string | null;
          dispatched_run_id: string | null;
        }
      >();
    return row === null
      ? null
      : {
          job: toRecord(row),
          repoId: row.project_repo_id,
          repo: row.project_repo,
          defaultBranch: row.project_default_branch,
          dispatchedRunId: row.dispatched_run_id,
        };
  }

  /**
   * Whether a job was already exchanged to this workflow run (0031: one run, one job, once). The run the dispatch
   * recorded on a job not yet claimed is not seen: it is the one run that job waits for (#723).
   */
  async isActionsRunSeen(runId: string): Promise<boolean> {
    const row = await this.db
      .prepare(`SELECT 1 AS seen FROM jobs WHERE actions_run_id = ?1 AND claimed_at IS NOT NULL`)
      .bind(runId)
      .first<{ seen: number }>();
    return row !== null;
  }

  /**
   * A queued, not yet dispatched Actions job with its project's repository and installation (#670); `null` for any
   * other job. The installation counts only while linked to the project's own account: a project never dispatches
   * through another account's installation (ADR 0008 decision 2, the two-account rule).
   */
  async findDispatchTarget(jobId: string, now: string): Promise<DispatchTargetRecord | null> {
    const entitled = await this.entitledConcurrencyOfJob(jobId);
    if (entitled === null) {
      return null;
    }
    const row = await this.db
      .prepare(
        `SELECT ${PREFIXED_COLUMNS}, p.repo AS project_repo, p.repo_id AS project_repo_id,
           p.default_branch AS project_default_branch,
           (SELECT CAST(i.installation_id AS INTEGER) FROM installations i
            WHERE i.provider = p.provider AND i.installation_id = CAST(p.installation_id AS TEXT)
              AND i.account_id = p.account_id AND i.unlinked_at IS NULL AND i.suspended_at IS NULL) AS linked_installation_id,
           (${dispatchAdmittedSql('?2', '?3', '?4', entitledConcurrencyAdmittedSql('?5', '?6', '?7'))}) AS admitted
         ${ADMISSION_FROM}
         WHERE j.id = ?1 AND j.state = 'queued' AND j.dispatch = 'actions' AND j.dispatched_at IS NULL`,
      )
      .bind(jobId, ...roleAdmissionParams(), now, ...entitledConcurrencyParams(entitled))
      .first<
        JobRow & {
          project_repo: string;
          project_repo_id: number | null;
          project_default_branch: string | null;
          linked_installation_id: number | null;
          admitted: number;
        }
      >();
    return row === null
      ? null
      : {
          job: toRecord(row),
          repo: row.project_repo,
          repoId: row.project_repo_id,
          installationId: row.linked_installation_id,
          defaultBranch: row.project_default_branch,
          admitted: row.admitted === 1,
        };
  }

  /**
   * The queued Actions jobs not dispatched yet that the exchange would admit now (#716): highest priority, then oldest,
   * at most `limit`, of one project, of one account or of all. Two jobs of a role one short of its `max_parallel`, or of
   * an account one short of its entitled concurrency (#746), both read as admitted here; `markDispatched` lets only the
   * first through. The entitlements are read first, one row per account with a waiting job, and bound as a map.
   */
  async listDispatchable(now: string, limit: number, scope: DispatchScope = {}): Promise<string[]> {
    const projectSlug = scope.projectSlug ?? null;
    const accountId = scope.accountId ?? null;
    const { results: accounts } = await this.db
      .prepare(
        `SELECT DISTINCT a.id, a.plan, a.entitlements FROM jobs j JOIN accounts a ON a.id = j.account_id
         WHERE ${UNDISPATCHED_SQL} AND (?1 IS NULL OR j.project_slug = ?1) AND (?2 IS NULL OR j.account_id = ?2)`,
      )
      .bind(projectSlug, accountId)
      .all<AccountEntitlementsRow>();
    if (accounts.length === 0) {
      return [];
    }
    const limits = JSON.stringify(Object.fromEntries(accounts.map((row) => [row.id, entitledConcurrencyOf(row).limit])));
    // An account missing from the map (its first job queued after the read) reads as 0: the next sweep takes it.
    const entitledLimit = `COALESCE((SELECT el.value FROM json_each(?7) el WHERE el.key = j.account_id), 0)`;
    const { results } = await this.db
      .prepare(
        `SELECT j.id ${ADMISSION_FROM}
         WHERE ${UNDISPATCHED_SQL} AND (?4 IS NULL OR j.project_slug = ?4) AND (?6 IS NULL OR j.account_id = ?6)
           AND ${dispatchAdmittedSql('?1', '?2', '?3', accountInFlightBelowSql(entitledLimit))}
         ORDER BY j.priority DESC, j.created_at ASC, j.id ASC
         LIMIT ?5`,
      )
      .bind(...roleAdmissionParams(), now, projectSlug, limit, accountId, limits)
      .all<{ id: string }>();
    return results.map((row) => row.id);
  }

  /**
   * The dispatch's compare-and-set (#670), recorded before the `workflow_dispatch` call: `false` when the job is no
   * longer waiting for one, or when the exchange would not admit it now (#722): the team paused, the role off or at
   * its `max_parallel` counting the runs already dispatched (#716), the budget used up, the account at its entitled
   * concurrency (#746). Judged by this one statement, so of two jobs racing for a role's or an account's last slot one
   * is dispatched and the other stays queued for a later dispatch.
   */
  async markDispatched(jobId: string, at: string): Promise<boolean> {
    const entitled = await this.entitledConcurrencyOfJob(jobId);
    if (entitled === null) {
      return false;
    }
    const { meta } = await this.db
      .prepare(
        `UPDATE jobs SET dispatched_at = ?2
         WHERE id = (SELECT j.id ${ADMISSION_FROM}
                     WHERE j.id = ?1 AND ${UNDISPATCHED_SQL}
                       AND ${dispatchAdmittedSql('?3', '?4', '?2', entitledConcurrencyAdmittedSql('?5', '?6', '?7'))})`,
      )
      .bind(jobId, at, ...roleAdmissionParams(), ...entitledConcurrencyParams(entitled))
      .run();
    return meta.changes === 1;
  }

  /**
   * The run GitHub started for a dispatched job (#723 item 2), from the dispatch call's answer: the exchange takes
   * the job for this run alone, so a run started by hand with the same `job_id` input never claims it. Written once,
   * only while the job is dispatched and still waits for its run; the job as written, or `null` when it no longer
   * waits (cancelled or failed meanwhile) or the run is already another job's (0031's index).
   */
  async recordDispatchedRun(jobId: string, runId: string): Promise<JobRecord | null> {
    try {
      const row = await this.db
        .prepare(
          `UPDATE jobs SET actions_run_id = ?2
           WHERE id = ?1 AND state = 'queued' AND dispatch = 'actions' AND dispatched_at IS NOT NULL
             AND runner_id IS NULL AND actions_run_id IS NULL
           RETURNING ${COLUMNS}`,
        )
        .bind(jobId, runId)
        .first<JobRow>();
      return row === null ? null : toRecord(row);
    } catch (error: unknown) {
      if (isConstraintError(error, 'UNIQUE constraint failed: jobs.actions_run_id')) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Fails a queued Actions job no runner holds (#670): its dispatch call failed (`dispatch-failed`) or no run came
   * for it (`actions-no-show`). `summary` is one of the console's own phrases, never GitHub's text. The job as
   * failed, or `null` when it was no longer waiting.
   */
  async failUndispatched(jobId: string, at: string, reason: string, summary: string): Promise<JobRecord | null> {
    const result = JSON.stringify({ summary, metrics: { reason }, acted: false });
    const failed: AuditCondition = {
      exists: `SELECT 1 FROM jobs WHERE id = ? AND state = 'failed' AND finished_at = ?`,
      params: [jobId, at],
    };
    const [update] = await this.db.batch([
      this.db
        .prepare(
          `UPDATE jobs SET state = 'failed', finished_at = ?2, result = ?3
           WHERE id = ?1 AND state = 'queued' AND dispatch = 'actions' AND runner_id IS NULL
           RETURNING ${COLUMNS}`,
        )
        .bind(jobId, at, result),
      this.eventStatement(jobId, at, { level: 'error', kind: 'failed', payload: { reason, summary } }, failed),
    ]);
    const row = (update?.results as JobRow[] | undefined)?.[0];
    return row === undefined ? null : toRecord(row);
  }

  /**
   * The no-show sweep (#670, the Cron Trigger): an Actions job still queued `minutes` after it was dispatched fails as
   * `actions-no-show`. The clock starts at the dispatch (#716): a job held back by a pause, a switched-off role, its
   * role's `max_parallel` or the budget waits undispatched, and the sweep dispatches it once it is admitted.
   */
  async failActionsNoShows(now: string, minutes: number, reason: string): Promise<string[]> {
    const cutoff = new Date(Date.parse(now) - minutes * 60_000).toISOString();
    const { results } = await this.db
      .prepare(
        `SELECT id FROM jobs
         WHERE state = 'queued' AND dispatch = 'actions' AND runner_id IS NULL
           AND dispatched_at IS NOT NULL AND dispatched_at < ?1
         ORDER BY id LIMIT 100`,
      )
      .bind(cutoff)
      .all<{ id: string }>();
    const failed: string[] = [];
    for (const { id } of results) {
      if ((await this.failUndispatched(id, now, reason, reason)) !== null) {
        failed.push(id);
      }
    }
    return failed;
  }

  /**
   * The OIDC exchange's one batch (#668, architect note on #573): the ephemeral runner row (`actions-ephemeral`, its
   * project alone, one job at a time) and the claim of the job for it, each with its audit row, and the job's
   * `claimed` notice. Both writes hold the same condition — the job queued, dispatched to Actions, unclaimed and never
   * exchanged, of a live account and project on an API key (ADR 0009 d.3, #682), its team not paused — so they land
   * together or not at all; of two exchanges racing for one job, one writes. A `run_id` another job holds fails the
   * whole batch on 0031's index. The claim stamps the current team-config revision, as the pull claim does (#687).
   */
  async exchangeForActions(exchange: ActionsExchange): Promise<ActionsExchangeOutcome> {
    const from = ADMISSION_FROM;
    // #695: never a `needs_local` job (the owner's own machine only), and only one the console dispatched itself, so
    // a hand-started run cannot take a queued job first; #723: and only for the run that dispatch started, so a run
    // started by hand for a job already dispatched cannot either. Actions jobs are never requeued, so `claimed_at`
    // still NULL means no run has exchanged for it. #706: the role admission of the pull claim, in this same
    // statement, so two exchanges racing for two jobs of one role never both pass `max_parallel`. #684: the budget.
    // #746: the account's entitled concurrency, `j` left out of the count it was dispatched into.
    const entitled = await this.entitledConcurrencyOfJob(exchange.jobId);
    if (entitled === null) {
      return { kind: 'not-claimable' };
    }
    const [limit, plan, entitlements] = entitledConcurrencyParams(entitled);
    const claimable = (
      presets: string,
      top: string,
      now: string,
      runId: string,
      concurrency: readonly [string, string, string],
    ): string => `j.id = ?1
      AND j.state = 'queued' AND j.dispatch = 'actions' AND j.runner_id IS NULL AND j.claimed_at IS NULL
      AND j.actions_run_id = ${runId} AND j.needs_local = 0 AND j.dispatched_at IS NOT NULL
      AND a.suspended_at IS NULL AND p.archived_at IS NULL AND t.paused_at IS NULL
      AND p.access_source = 'api_key'
      AND ${roleAdmittedSql(presets, top)}
      AND ${budgetAdmittedSql(now)}
      AND ${entitledConcurrencyAdmittedSql(...concurrency)}`;
    const [presets, top] = roleAdmissionParams();
    const held: AuditCondition = {
      exists: `SELECT 1 FROM jobs WHERE jobs.id = ? AND jobs.runner_id = ? AND jobs.state = 'claimed'`,
      params: [exchange.jobId, exchange.runnerId],
    };
    let results: D1Result[];
    try {
      results = await this.db.batch([
        ...auditedWrite(
          this.db,
          this.db
            .prepare(
              `INSERT INTO runners (id, account_id, name, public_key_jwk, host, capabilities, isolation, allowed_projects,
                 version, enrolled_at, last_seen_at, last_seen_country, last_seen_ip_hash, seen_countries)
               SELECT ?2, j.account_id, ?3, ?4, ?5, '{"local":false,"maxConcurrency":1,"accessSources":["api_key"]}', 'actions-ephemeral',
                 json_array(j.project_slug), ?6, ?7, ?7, ?8, ?9, CASE WHEN ?8 IS NULL THEN '[]' ELSE json_array(?8) END
               ${from} WHERE ${claimable('?10', '?11', '?7', '?12', ['?13', '?14', '?15'])}`,
            )
            .bind(
              exchange.jobId,
              exchange.runnerId,
              exchange.runnerName,
              JSON.stringify(exchange.publicKeyJwk),
              JSON.stringify(exchange.host),
              exchange.version,
              exchange.now,
              exchange.country,
              exchange.ipHash,
              presets,
              top,
              exchange.runId,
              limit,
              plan,
              entitlements,
            ),
          exchange.enrolledAudit,
        ),
        ...auditedWrite(
          this.db,
          this.db
            .prepare(
              `UPDATE jobs SET state = 'claimed', runner_id = ?2, claimed_at = ?3, lease_until = ?4, token_hash = ?5,
                 actions_run_id = ?6, attempt = attempt + 1,
                 team_config_revision = (SELECT revision FROM team_configs WHERE project_slug = jobs.project_slug)
               WHERE id = (SELECT j.id ${from} WHERE ${claimable('?7', '?8', '?3', '?6', ['?9', '?10', '?11'])})
                 AND EXISTS (
                   SELECT 1 FROM runners r WHERE r.id = ?2 AND r.account_id = jobs.account_id AND r.revoked_at IS NULL)`,
            )
            .bind(
              exchange.jobId,
              exchange.runnerId,
              exchange.now,
              exchange.leaseUntil,
              exchange.tokenHash,
              exchange.runId,
              presets,
              top,
              limit,
              plan,
              entitlements,
            ),
          exchange.claimedAudit,
        ),
        this.eventStatement(
          exchange.jobId,
          exchange.now,
          {
            level: 'info',
            kind: 'notice',
            payload: { claimed: true, runnerId: exchange.runnerId, attempt: 1, via: 'actions' },
          },
          held,
        ),
      ]);
    } catch (error: unknown) {
      if (isConstraintError(error, 'UNIQUE constraint failed: jobs.actions_run_id')) {
        return { kind: 'run-seen' };
      }
      throw error;
    }
    if ((results[2]?.meta.changes ?? 0) !== 1) {
      // The batch judged the source; this read only names why nothing was written.
      const project = await this.db
        .prepare(`SELECT p.access_source FROM jobs j JOIN projects p ON p.slug = j.project_slug WHERE j.id = ?1`)
        .bind(exchange.jobId)
        .first<{ access_source: string }>();
      return project !== null && project.access_source !== 'api_key' ? { kind: 'access-source' } : { kind: 'not-claimable' };
    }
    const job = await this.findById(exchange.jobId);
    return job === null ? { kind: 'not-claimable' } : { kind: 'claimed', job };
  }

  /**
   * Extends the lease of a job this runner holds; `false` when it holds no such live job, or its stored row no longer
   * allows the job's project or is revoked (#553).
   */
  async heartbeat(id: string, runnerId: string, now: string, leaseUntil: string): Promise<boolean> {
    const { meta } = await this.db
      .prepare(
        `UPDATE jobs SET lease_until = ?4
         WHERE id = ?1 AND runner_id = ?2 AND state IN ('claimed', 'running') AND lease_until >= ?3
           AND ${RUNNER_STILL_ALLOWS_SQL}`,
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
   * Appends a batch of events (redacted) to a live job `runnerId` holds, numbered after the last; a `started` event
   * also marks the job running. Every statement is guarded on the hold — the runner, a live lease, and its stored row
   * still allowing the project (#553) — so `held: false` means nothing was written. Returns the last `seq` and whether
   * the cap cut the batch.
   */
  async appendEvents(
    id: string,
    runnerId: string,
    events: readonly JobEventInput[],
    now: string,
  ): Promise<{ readonly held: boolean; readonly lastSeq: number; readonly capped: boolean }> {
    const held: AuditCondition = {
      exists: `SELECT 1 FROM jobs WHERE jobs.id = ? AND jobs.runner_id = ? AND jobs.state IN ('claimed', 'running')
        AND jobs.lease_until >= ? AND ${RUNNER_STILL_ALLOWS_SQL}`,
      params: [id, runnerId, now],
    };
    const statements = events.map((event) => this.eventStatement(id, now, event, held));
    if (events.some((event) => event.kind === 'started')) {
      statements.push(
        this.db
          .prepare(
            `UPDATE jobs SET state = 'running', started_at = COALESCE(started_at, ?2)
             WHERE id = ?1 AND state = 'claimed' AND runner_id = ?3 AND lease_until >= ?2 AND ${RUNNER_STILL_ALLOWS_SQL}`,
          )
          .bind(id, now, runnerId),
      );
    }
    // Read in the same batch (one transaction), so `held` is the very judgement the inserts above saw.
    statements.push(
      this.db
        .prepare(`SELECT COALESCE(MAX(seq), 0) AS seq, EXISTS (${held.exists}) AS held FROM job_events WHERE job_id = ?`)
        .bind(...held.params, id),
    );
    const results = await this.db.batch(statements);
    const written = results.slice(0, events.length).filter((result) => result.meta.changes === 1).length;
    const last = (results.at(-1)?.results[0] ?? null) as { seq: number; held: number } | null;
    const isHeld = last?.held === 1;
    return { held: isHeld, lastSeq: last?.seq ?? 0, capped: isHeld && written < events.length };
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

  /**
   * Finishes a job this runner holds, with its `finished`/`failed` event and the audit row; `false` when it holds none
   * or its stored row no longer allows the job's project or is revoked (#553).
   *
   * The budget stop (#684, ADR 0009 d.6, threat model C12 row 5) rides in the same batch. The job's cost is added to its
   * project's spend for the UTC month of `now` by the statement right after the state transition, and only when that
   * transition took (`AUDITED_WRITE_HAPPENED_SQL`), so a replayed or second `finish` adds nothing. When the month's spend then reaches
   * `budget.monthly_usd` and the owner has not waived it, the team is paused by `system:budget` with one `team.paused`
   * row; N finishes past the cap still pause it once. A pause already on (the owner's, the failure streak's) is kept as
   * it is: only its holder lifts it, and Needs you shows the budget row beside it (`TeamStateRepo.budgetStopsOf`).
   * Without `spend` nothing of the budget is written (#732).
   */
  async finish(
    id: string,
    runnerId: string,
    outcome: { readonly result: 'finished' | 'failed'; readonly summary: string; readonly metrics: Readonly<Record<string, unknown>>; readonly acted: boolean },
    now: string,
    audit: NewAuditEvent,
    spend?: FinishSpend,
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
           WHERE id = ?1 AND runner_id = ?2 AND state IN ('claimed', 'running') AND lease_until >= ?4
             AND ${RUNNER_STILL_ALLOWS_SQL}`,
        )
        .bind(id, runnerId, outcome.result, now, JSON.stringify(result)),
      // Directly after the transition, so "the previous statement wrote" is that UPDATE having taken.
      ...(spend === undefined
        ? []
        : [
            this.db
              .prepare(
                `INSERT INTO project_spend (project_slug, month, spent_usd, jobs)
                 SELECT project_slug, substr(?2, 1, 7), ?3, 1 FROM jobs WHERE id = ?1 AND ${AUDITED_WRITE_HAPPENED_SQL}
                 ON CONFLICT (project_slug, month) DO UPDATE SET spent_usd = spent_usd + ?3, jobs = jobs + 1`,
              )
              .bind(id, now, spend.costUsd),
          ]),
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
      // #668: an ephemeral Actions identity ends with its one job, in the finish's own batch.
      this.db
        .prepare(
          `UPDATE runners SET revoked_at = ?
           WHERE id = ? AND isolation = 'actions-ephemeral' AND revoked_at IS NULL AND EXISTS (${finished.exists})`,
        )
        .bind(now, runnerId, ...finished.params),
      ...(spend === undefined ? [] : this.budgetPauseStatements(id, finished, now, spend.pauseAudit)),
    ]);
    return update?.meta.changes === 1;
  }

  /** `finish`'s `system:budget` pause and its audit row: only when this finish took and the month's cap is reached. */
  private budgetPauseStatements(
    id: string,
    finished: AuditCondition,
    now: string,
    audit: NewAuditEvent,
  ): readonly D1PreparedStatement[] {
    return auditedWrite(
      this.db,
      this.db
        .prepare(
          `INSERT INTO team_state (project_slug, paused_at, paused_by, failed_streak, updated_at)
           SELECT j.project_slug, ?1, ?2, 0, ?1 FROM jobs j
             JOIN project_spend ps ON ps.project_slug = j.project_slug AND ps.month = substr(?1, 1, 7)
             JOIN team_configs tc ON tc.project_slug = j.project_slug
           WHERE j.id = ?3 AND EXISTS (${finished.exists})
             AND ps.waived_at IS NULL AND ps.spent_usd >= json_extract(tc.config, '$.budget.monthly_usd')
           ON CONFLICT (project_slug) DO UPDATE SET paused_at = excluded.paused_at, paused_by = excluded.paused_by,
             updated_at = excluded.updated_at
           WHERE team_state.paused_at IS NULL`,
        )
        .bind(now, BUDGET_PAUSER, id, ...finished.params),
      audit,
    );
  }

  /**
   * The statements that cancel this runner's live jobs outside `slugs`, for the allow-list write's batch (#490 review).
   * `AUDITED_WRITE_HAPPENED_SQL` reads the audit row just before it (#533): they run only when the write happened, so they must come
   * directly after the `auditedWrite` pair, as `RunnersRepo.setAllowedProjects` places them.
   */
  cancelOutsideStatements(runnerId: string, slugs: readonly string[], now: string): D1PreparedStatement[] {
    return [
      this.db
        .prepare(
          `UPDATE jobs SET state = 'cancelled', finished_at = ?2, result = '{"reason":"runner-allow-list"}', token_hash = NULL, lease_until = NULL
           WHERE runner_id = ?1 AND state IN ('claimed', 'running') AND project_slug NOT IN (SELECT value FROM json_each(?3))
             AND ${AUDITED_WRITE_HAPPENED_SQL}`,
        )
        .bind(runnerId, now, JSON.stringify(slugs)),
    ];
  }

  /**
   * The statements that cancel a runner's live jobs, for the revoke batch (ADR 0006: revoking cancels claimed jobs).
   * `AUDITED_WRITE_HAPPENED_SQL` reads the audit row just before it (#533): a revoke that lost the race wrote no audit row and so
   * cancels nothing. They must come directly after the `auditedWrite` pair, as `RunnersRepo.revoke` places them.
   */
  cancelForRunnerStatements(runnerId: string, now: string): D1PreparedStatement[] {
    return [
      this.db
        .prepare(
          `UPDATE jobs SET state = 'cancelled', finished_at = ?2, result = '{"reason":"runner-revoked"}', token_hash = NULL, lease_until = NULL
           WHERE runner_id = ?1 AND state IN ('claimed', 'running') AND ${AUDITED_WRITE_HAPPENED_SQL}`,
        )
        .bind(runnerId, now),
    ];
  }
}
