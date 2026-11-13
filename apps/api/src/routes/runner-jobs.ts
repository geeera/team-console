import { Hono } from 'hono';
import {
  JOB_LEASE_SECONDS,
  RUNNER_POLL_SECONDS,
  checkFinishJobInput,
  checkJobEventsInput,
  isUlid,
  type ClaimResponse,
  type HeartbeatResponse,
  type JobEventsResponse,
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
import { AuditRepo, JobsRepo, TeamStateRepo, type JobRecord, type NewAuditEvent } from '@worker/db';
import type { Identity } from '../auth/auth.types';
import type { ApiEnv } from '../env';
import { jsonBody } from '../json-body';
import { SMALL_WRITE_MAX_BYTES, TEXT_WRITE_MAX_BYTES, writeLimit } from '../tracker/http';
import { jobDtoOf } from './jobs';

type Context = WorkerContext<ApiEnv>;
type RunnerIdentity = Extract<Identity, { kind: 'runner' }>;

function runnerOf(c: Context): RunnerIdentity {
  const identity = c.get('identity');
  if (identity.kind !== 'runner') {
    // The route scope admits `runner` alone; anything else here is a bug, never an open door.
    throw new Error('runner route reached without a runner identity');
  }
  return identity;
}

/** A 256-bit opaque job token under the prefix the redactor knows (ADR 0006 decision 8, ADR 0008 decision 1). */
function newJobToken(): string {
  return randomOpaqueToken(JOB_TOKEN_PREFIX);
}

function invalid(c: Context, type: string, field: string, detail: string): Response {
  const extensions: Record<string, ProblemExtensionValue> = { field };
  return problem(c, { type, title: 'Invalid request', status: 422, detail, extensions });
}

/** The job behind `:id` as this runner's live job; another runner's or a finished one is 404/409, never 403 with detail. */
async function heldJobOf(c: Context, runner: RunnerIdentity, now: string): Promise<JobRecord | Response> {
  const id = c.req.param('id') ?? '';
  const job = isUlid(id) ? await new JobsRepo(c.env.DB).findById(id) : null;
  // The allow-list is judged again (#490 review): a project the runner lost since the claim is no longer its.
  if (job === null || job.runnerId !== runner.runnerId || !runner.allowedProjects.includes(job.projectSlug)) {
    return problem(c, { type: 'job-not-found', title: 'Job not found', status: 404 });
  }
  if (job.state !== 'claimed' && job.state !== 'running') {
    return problem(c, { type: 'job-finished', title: 'Conflict', status: 409, detail: `The job is ${job.state}` });
  }
  if (job.leaseUntil === null || job.leaseUntil < now) {
    return problem(c, { type: 'job-lease-expired', title: 'Conflict', status: 409 });
  }
  return job;
}

function auditOf(runner: RunnerIdentity, job: JobRecord, at: string, kind: NewAuditEvent['kind'], details: Readonly<Record<string, unknown>>, ipCountry: string | null): NewAuditEvent {
  return { accountId: job.accountId, at, actorKind: 'runner', actor: runner.runnerId, kind, target: job.id, details, ipCountry };
}

/**
 * `POST /api/v1/runner/jobs/claim|:id/heartbeat|:id/events|:id/finish` (#467, ADR 0006 "Claim", "Run", "Report";
 * ADR 0008 decisions 2, 8 and 12). The runner identity comes from its JWT (`runner-auth.ts`); the claim is
 * `JobsRepo.claim`, one UPDATE that holds the account match, the allow-list, the pause and the placement policy; the
 * job token it mints is accepted only with this runner's JWT (`job-auth.ts`, R4). Events and the finish summary go
 * through the shared redactor before an append-only row takes them.
 */
export function createRunnerJobRoutes(): Hono<WorkerHonoEnv<ApiEnv>> {
  return new Hono<WorkerHonoEnv<ApiEnv>>()
    .post('/jobs/claim', writeLimit(SMALL_WRITE_MAX_BYTES), async (c) => {
      const runner = runnerOf(c);
      const logger = c.get('logger');
      // ADR 0008 decision 8: a runner without isolation serves fixture environments only.
      if (runner.isolation === 'none' && c.env.ENVIRONMENT === 'production') {
        logger.warn('claim refused', { reason: 'runner-isolation-none', runnerId: runner.runnerId });
        return problem(c, { type: 'runner-isolation-none', title: 'Forbidden', status: 403 });
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
      await jobs.appendEvents(job.id, [{ level: 'info', kind: 'notice', payload: { claimed: true, runnerId: runner.runnerId, attempt: job.attempt } }], nowIso);
      const country = c.req.header('CF-IPCountry') ?? null;
      await new AuditRepo(c.env.DB).append(
        auditOf(runner, job, nowIso, 'job.claimed', { kind: job.kind, slug: job.projectSlug, attempt: job.attempt, country }, country),
      );
      logger.info('job claimed', { jobId: job.id, runnerId: runner.runnerId, kind: job.kind });
      const body: ClaimResponse = { job: jobDtoOf(job), jobToken: token, leaseSeconds: JOB_LEASE_SECONDS };
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
        return problem(c, { type: 'job-lease-expired', title: 'Conflict', status: 409, detail: 'The job is past its maxMinutes' });
      }
      const leaseUntil = new Date(Math.min(now.getTime() + JOB_LEASE_SECONDS * 1000, deadline)).toISOString();
      if (!(await new JobsRepo(c.env.DB).heartbeat(job.id, runner.runnerId, now.toISOString(), leaseUntil))) {
        return problem(c, { type: 'job-lease-expired', title: 'Conflict', status: 409 });
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
      const written = await new JobsRepo(c.env.DB).appendEvents(job.id, input.value.events, now);
      if (written.capped) {
        c.get('logger').warn('job events capped', { jobId: job.id });
      }
      const body: JobEventsResponse = written;
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
      const finished = await new JobsRepo(c.env.DB).finish(
        job.id,
        runner.runnerId,
        input.value,
        now,
        auditOf(runner, job, now, 'job.finished', { result: input.value.result, kind: job.kind, slug: job.projectSlug, acted: input.value.acted }, country),
      );
      if (!finished) {
        return problem(c, { type: 'job-lease-expired', title: 'Conflict', status: 409 });
      }
      const streak = await new TeamStateRepo(c.env.DB).recordOutcome(job.projectSlug, input.value.result, now, {
        accountId: job.accountId,
        at: now,
        actorKind: 'system',
        actor: 'failure-streak',
        kind: 'team.paused',
        target: job.projectSlug,
        details: { reason: 'failure-streak', jobId: job.id },
        ipCountry: null,
      });
      if (streak.paused) {
        c.get('logger').warn('team paused on the failure streak', { slug: job.projectSlug });
      }
      const updated = await new JobsRepo(c.env.DB).findById(job.id);
      return c.json(updated === null ? null : jobDtoOf(updated));
    });
}
