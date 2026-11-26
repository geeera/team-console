import { Hono } from 'hono';
import {
  JOB_LEASE_SECONDS,
  RUNNER_POLL_SECONDS,
  checkClaimRunnerInput,
  checkFinishJobInput,
  checkJobEventsInput,
  finishCostOf,
  isUlid,
  type ClaimResponse,
  type HeartbeatResponse,
  type JobEventsResponse,
  type RunnerScopeDto,
} from '@shared/contracts';
import { JOB_TOKEN_PREFIX } from '@shared/redaction';
import {
  problem,
  randomOpaqueToken,
  sha256Hex,
  type ProblemExtensionValue,
  type WorkerContext,
  type WorkerHonoEnv,
} from '@worker/core';
import {
  AuditRepo,
  JobsRepo,
  RunnersRepo,
  TeamStateRepo,
  type HeldJobRecord,
  type JobRecord,
  type NewAuditEvent,
  type RunnerRecord,
} from '@worker/db';
import { dispatchAdmittedActionsJobs } from '../actions/dispatch';
import type { Identity } from '../auth/auth.types';
import type { ApiEnv } from '../env';
import type { ApiGitHub } from '../github';
import { jsonBody } from '../json-body';
import { SMALL_WRITE_MAX_BYTES, TEXT_WRITE_MAX_BYTES, writeLimit } from '../tracker/http';
import { claimTeamConfigOf } from '../team-config/resolved';
import { jobDtoOf } from './jobs';

type Context = WorkerContext<ApiEnv>;
export type RunnerIdentity = Extract<Identity, { kind: 'runner' }>;

export function runnerOf(c: Context): RunnerIdentity {
  const identity = c.get('identity');
  if (identity.kind !== 'runner') {
    // The route scope admits `runner` alone; anything else here is a bug, never an open door.
    throw new Error('runner route reached without a runner identity');
  }
  return identity;
}

/** Runs a finish may start for the jobs it unblocked: one slot freed, and a little room for a role that was waiting. */
const FINISH_DISPATCH_MAX = 2;

/** A 256-bit opaque job token under the prefix the redactor knows (ADR 0006 decision 8, ADR 0008 decision 1). */
function newJobToken(): string {
  return randomOpaqueToken(JOB_TOKEN_PREFIX);
}

function invalid(c: Context, type: string, field: string, detail: string): Response {
  const extensions: Record<string, ProblemExtensionValue> = { field };
  return problem(c, { type, title: 'Invalid request', status: 422, detail, extensions });
}

/** `job` as the live job of the runner `runnerId` under its scope; another runner's or a finished one is 404/409. */
function judgeHeld(
  c: Context,
  job: HeldJobRecord | null,
  runnerId: string,
  now: string,
): JobRecord | Response {
  // The scope is judged again (#490 review, #775) by the claim's own term, read with the job (#794, D3 included): a
  // project the runner lost since the claim is no longer its.
  if (job === null || job.runnerId !== runnerId || !job.runnerServes) {
    return problem(c, { type: 'job-not-found', title: 'Job not found', status: 404 });
  }
  if (job.state !== 'claimed' && job.state !== 'running') {
    return problem(c, {
      type: 'job-finished',
      title: 'Conflict',
      status: 409,
      detail: `The job is ${job.state}`,
    });
  }
  if (job.leaseUntil === null || job.leaseUntil < now) {
    return problem(c, { type: 'job-lease-expired', title: 'Conflict', status: 409 });
  }
  return job;
}

/** The job behind `:id` as this runner's live job, judged on the stored runner row in the same read (#794). */
async function heldJobOf(c: Context, runner: RunnerIdentity, now: string): Promise<JobRecord | Response> {
  const id = c.req.param('id') ?? '';
  const job = isUlid(id) ? await new JobsRepo(c.env.DB).findHeldById(id) : null;
  if (job !== null && job.runnerId === runner.runnerId && !job.runnerServes) {
    // The stored row no longer serves it: a revoke since authentication answers as the runner door does.
    return lostWriteRefusal(c, runner, job.id, now);
  }
  return judgeHeld(c, job, runner.runnerId, now);
}

/** The scope as the claim applied it (#775): the stored row plus the effective project list, D3 included. */
async function scopeOf(repo: RunnersRepo, runner: RunnerRecord): Promise<RunnerScopeDto> {
  const served = await repo.servedProjectsOf(runner.accountId, runner.id);
  return {
    projectScope: runner.projectScope,
    allowedProjects: runner.allowedProjects,
    projects: served.map((project) => project.slug),
  };
}

/**
 * The answer for a guarded write that took nothing (#553). The write judged the stored runner row, which can have
 * changed since authentication; this re-reads it so a revoke answers as the runner door does (401 `runner-revoked`)
 * and a narrowing as a job that is no longer this runner's (404). Read only on this refusal path, never per call.
 */
async function lostWriteRefusal(
  c: Context,
  runner: RunnerIdentity,
  jobId: string,
  now: string,
): Promise<Response> {
  const [job, stored] = await Promise.all([
    new JobsRepo(c.env.DB).findHeldById(jobId),
    new RunnersRepo(c.env.DB).findById(runner.runnerId),
  ]);
  if (stored === null || stored.revokedAt !== null) {
    c.get('logger').warn('runner rejected', { reason: 'runner-revoked' });
    return problem(c, { type: 'runner-revoked', title: 'Unauthorized', status: 401 });
  }
  // `runnerServes` holds the account equality of the stored row; a row of another account (impossible past 0021's
  // identity trigger) serves nothing.
  const judged = judgeHeld(c, stored.accountId === runner.accountId ? job : null, runner.runnerId, now);
  return judged instanceof Response
    ? judged
    : problem(c, { type: 'job-lease-expired', title: 'Conflict', status: 409 });
}

function auditOf(
  runner: RunnerIdentity,
  job: JobRecord,
  at: string,
  kind: NewAuditEvent['kind'],
  details: Readonly<Record<string, unknown>>,
  ipCountry: string | null,
): NewAuditEvent {
  return {
    accountId: job.accountId,
    at,
    actorKind: 'runner',
    actor: runner.runnerId,
    kind,
    target: job.id,
    details,
    ipCountry,
  };
}

/**
 * `POST /api/v1/runner/jobs/claim|:id/heartbeat|:id/events|:id/finish` (#467, ADR 0006 "Claim", "Run", "Report";
 * ADR 0008 decisions 2, 8 and 12). The runner identity comes from its JWT (`runner-auth.ts`); the claim is
 * `JobsRepo.claim`, one UPDATE that holds the account match, the allow-list, the pause and the placement policy; the
 * job token it mints is accepted only with this runner's JWT (`job-auth.ts`, R4). Events and the finish summary go
 * through the shared redactor before an append-only row takes them.
 */
export function createRunnerJobRoutes(github: ApiGitHub): Hono<WorkerHonoEnv<ApiEnv>> {
  return new Hono<WorkerHonoEnv<ApiEnv>>()
    .post('/jobs/claim', writeLimit(SMALL_WRITE_MAX_BYTES), async (c) => {
      const runner = runnerOf(c);
      const logger = c.get('logger');
      // ADR 0008 decision 8: a runner without isolation serves fixture environments only.
      if (runner.isolation === 'none' && c.env.ENVIRONMENT === 'production') {
        logger.warn('claim refused', { reason: 'runner-isolation-none', runnerId: runner.runnerId });
        return problem(c, { type: 'runner-isolation-none', title: 'Forbidden', status: 403 });
      }
      // #668: an Actions identity holds the one job its exchange claimed and never pulls another.
      if (runner.isolation === 'actions-ephemeral') {
        logger.warn('claim refused', { reason: 'runner-isolation-ephemeral', runnerId: runner.runnerId });
        return problem(c, { type: 'runner-isolation-ephemeral', title: 'Forbidden', status: 403 });
      }
      const input = checkClaimRunnerInput(await jsonBody(c));
      if (!input.ok) {
        return invalid(c, 'claim-invalid', input.field, input.detail);
      }
      const runners = new RunnersRepo(c.env.DB);
      // #775 (SECURITY question 7): the declaration is stored before the claim reads it, so the claim's `AND` term
      // judges the stored row; a hosted or ephemeral identity's declaration is ignored by the write itself.
      if (
        input.value.accessSources !== undefined &&
        (await runners.setAccessSources(runner.runnerId, input.value.accessSources))
      ) {
        logger.info('runner declared access sources', {
          runnerId: runner.runnerId,
          accessSources: input.value.accessSources,
        });
      }
      const now = new Date();
      const nowIso = now.toISOString();
      const jobs = new JobsRepo(c.env.DB);
      const teamState = new TeamStateRepo(c.env.DB);
      const lapsed = await jobs.requeueLapsed(nowIso);
      for (const lost of lapsed.lost) {
        await teamState.recordOutcome(lost.projectSlug, 'failed', nowIso);
      }
      const token = newJobToken();
      const job = await jobs.claim({
        runnerId: runner.runnerId,
        accountId: runner.accountId,
        local: runner.capabilities.local,
        tokenHash: await sha256Hex(token),
        now: nowIso,
        leaseUntil: new Date(now.getTime() + JOB_LEASE_SECONDS * 1000).toISOString(),
      });
      if (job === null) {
        c.header('Retry-After', String(RUNNER_POLL_SECONDS));
        return c.body(null, 204);
      }
      const stored = await runners.findInAccount(runner.accountId, runner.runnerId);
      if (stored === null) {
        // The claim just wrote this runner's id on the job; a missing row is a bug, never an open door.
        throw new Error('the claiming runner has no row');
      }
      await jobs.appendEvents(
        job.id,
        runner.runnerId,
        [
          {
            level: 'info',
            kind: 'notice',
            payload: { claimed: true, runnerId: runner.runnerId, attempt: job.attempt },
          },
        ],
        nowIso,
      );
      const country = c.req.header('CF-IPCountry') ?? null;
      await new AuditRepo(c.env.DB).append(
        auditOf(
          runner,
          job,
          nowIso,
          'job.claimed',
          { kind: job.kind, slug: job.projectSlug, attempt: job.attempt, country },
          country,
        ),
      );
      logger.info('job claimed', { jobId: job.id, runnerId: runner.runnerId, kind: job.kind });
      const body: ClaimResponse = {
        job: jobDtoOf(job),
        jobToken: token,
        leaseSeconds: JOB_LEASE_SECONDS,
        // #775: the scope as this claim applied it; the runner holds itself to it, not to the enrol-time copy.
        scope: await scopeOf(runners, stored),
        // #687: the stamped revision's view; a change after this claim applies to the next one.
        ...(await claimTeamConfigOf(c.env.DB, job)),
      };
      return c.json(body);
    })

    .post('/jobs/:id/heartbeat', async (c) => {
      const runner = runnerOf(c);
      const now = new Date();
      const job = await heldJobOf(c, runner, now.toISOString());
      if (job instanceof Response) {
        return job;
      }
      // The lease never runs past the job's wall-clock limit (#490 review): `maxMinutes` is a server-side cap, not
      // only the runner's kill, counted from the start (or the claim, before any `started` event).
      const since = Date.parse(job.startedAt ?? job.claimedAt ?? now.toISOString());
      const deadline = since + job.maxMinutes * 60 * 1000;
      if (deadline <= now.getTime()) {
        return problem(c, {
          type: 'job-lease-expired',
          title: 'Conflict',
          status: 409,
          detail: 'The job is past its maxMinutes',
        });
      }
      const leaseUntil = new Date(Math.min(now.getTime() + JOB_LEASE_SECONDS * 1000, deadline)).toISOString();
      if (!(await new JobsRepo(c.env.DB).heartbeat(job.id, runner.runnerId, now.toISOString(), leaseUntil))) {
        return lostWriteRefusal(c, runner, job.id, now.toISOString());
      }
      const body: HeartbeatResponse = { leaseUntil };
      return c.json(body);
    })

    .post('/jobs/:id/events', writeLimit(TEXT_WRITE_MAX_BYTES), async (c) => {
      const runner = runnerOf(c);
      const now = new Date().toISOString();
      const job = await heldJobOf(c, runner, now);
      if (job instanceof Response) {
        return job;
      }
      const input = checkJobEventsInput(await jsonBody(c));
      if (!input.ok) {
        return invalid(c, 'job-events-invalid', input.field, input.detail);
      }
      const written = await new JobsRepo(c.env.DB).appendEvents(
        job.id,
        runner.runnerId,
        input.value.events,
        now,
      );
      if (!written.held) {
        return lostWriteRefusal(c, runner, job.id, now);
      }
      if (written.capped) {
        c.get('logger').warn('job events capped', { jobId: job.id });
      }
      const body: JobEventsResponse = { lastSeq: written.lastSeq, capped: written.capped };
      return c.json(body, 201);
    })

    .post('/jobs/:id/finish', writeLimit(SMALL_WRITE_MAX_BYTES), async (c) => {
      const runner = runnerOf(c);
      const now = new Date().toISOString();
      const job = await heldJobOf(c, runner, now);
      if (job instanceof Response) {
        return job;
      }
      const input = checkFinishJobInput(await jsonBody(c));
      if (!input.ok) {
        return invalid(c, 'job-finish-invalid', input.field, input.detail);
      }
      const country = c.req.header('CF-IPCountry') ?? null;
      const logger = c.get('logger');
      // #684: the CLI's own figure, a floor of what the job spent (ADR 0009 d.6); none reported counts as nothing.
      const costUsd = finishCostOf(input.value.metrics);
      if (costUsd === null) {
        logger.info('job finished without a cost', { jobId: job.id, slug: job.projectSlug });
      }
      const finished = await new JobsRepo(c.env.DB).finish(
        job.id,
        runner.runnerId,
        input.value,
        now,
        auditOf(
          runner,
          job,
          now,
          'job.finished',
          { result: input.value.result, kind: job.kind, slug: job.projectSlug, acted: input.value.acted },
          country,
        ),
        {
          costUsd: costUsd ?? 0,
          pauseAudit: {
            accountId: job.accountId,
            at: now,
            actorKind: 'system',
            actor: 'budget',
            kind: 'team.paused',
            target: job.projectSlug,
            details: { reason: 'budget', jobId: job.id },
            ipCountry: null,
          },
        },
      );
      if (!finished) {
        return lostWriteRefusal(c, runner, job.id, now);
      }
      // A usage or rate limit (#571) is the runner's quota, not the project's fault: the streak leaves it out, but only
      // while this runner holds a pause (#596) — `metrics.reason` alone is the runner's say-so.
      const limitReason = input.value.metrics['reason'];
      const streak = await new TeamStateRepo(c.env.DB).recordOutcome(
        job.projectSlug,
        input.value.result,
        now,
        {
          accountId: job.accountId,
          at: now,
          actorKind: 'system',
          actor: 'failure-streak',
          kind: 'team.paused',
          target: job.projectSlug,
          details: { reason: 'failure-streak', jobId: job.id },
          ipCountry: null,
        },
        {
          reason: limitReason,
          runnerId: runner.runnerId,
          accountId: runner.accountId,
          audit: auditOf(
            runner,
            job,
            now,
            'job.streak-excluded',
            { reason: limitReason, slug: job.projectSlug },
            country,
          ),
        },
      );
      if (streak.paused) {
        logger.warn('team paused on the failure streak', { slug: job.projectSlug });
      }
      if (streak.excluded) {
        logger.info('failure left out of the streak', {
          jobId: job.id,
          runnerId: runner.runnerId,
          reason: limitReason,
        });
      }
      // #716, #746: this job's slot is free, so the account's Actions jobs held back by a role's `max_parallel` or by the
      // account's entitled concurrency get their run now rather than at the next sweep, whichever way this job ran. The
      // dispatch's own write judges admission; nothing here can start one too many. No waiting job reads nothing more.
      await dispatchAdmittedActionsJobs(
        { env: c.env, github, logger },
        { accountId: job.accountId, limit: FINISH_DISPATCH_MAX },
      );
      const updated = await new JobsRepo(c.env.DB).findById(job.id);
      return c.json(updated === null ? null : jobDtoOf(updated));
    });
}
