import { problem, sha256Hex, type Logger, type WorkerContext } from '@worker/core';
import { JobsRepo, RunnersRepo, type JobRecord, type JobTokenHold } from '@worker/db';
import type { ApiEnv } from '../env';
import type { Identity } from './auth.types';
import { isJobRole } from './job-roles';
import { RUNNER_JWT_HEADER, recordSighting, runnerJwtOf, runnerRefusal, verifyRunnerJwt } from './runner-auth';

type JobIdentity = Extract<Identity, { kind: 'job' }>;

interface JobRefusal {
  readonly type: string;
  readonly status: 401 | 403;
}

function refusalResponse(c: WorkerContext<ApiEnv>, logger: Logger, refusal: JobRefusal): Response {
  logger.warn('job token rejected', { reason: refusal.type });
  return problem(c, {
    type: refusal.type,
    title: refusal.status === 401 ? 'Unauthorized' : 'Forbidden',
    status: refusal.status,
  });
}

/**
 * Whether the job behind a token still holds for `runnerId` with `allowedProjects`: the same judgement at
 * authentication and after a tracker write's batch refused (#580), so both answer alike.
 */
function judgeJob(
  job: JobRecord | null,
  runnerId: string,
  allowedProjects: readonly string[],
  now: Date,
): JobRefusal | null {
  if (job === null) {
    return { type: 'job-token-invalid', status: 401 };
  }
  // The runner's allow-list is judged again here (#490 review): a project removed from it after the claim closes
  // the job's door at once, whatever the cancel batch managed.
  if (job.runnerId !== runnerId || !allowedProjects.includes(job.projectSlug)) {
    return { type: 'job-runner-mismatch', status: 403 };
  }
  if (
    (job.state !== 'claimed' && job.state !== 'running') ||
    job.leaseUntil === null ||
    job.leaseUntil < now.toISOString()
  ) {
    return { type: 'job-lease-expired', status: 401 };
  }
  return null;
}

/**
 * The job identity from a job token (#467, ADR 0006 decision 8 / R4, ADR 0008 "Identity, routes and the matrix"):
 * `Authorization: Bearer tcj_…` is accepted only together with the JWT of the runner that claimed the job, in
 * `X-Runner-Jwt` — a leaked job token is useless off its host. The runner JWT goes through the same checks as on the
 * runner's own door (signature, audience, lifetime, replay, revocation, rate limit, sighting); then the token's hash
 * must name a job that runner holds, still inside its lease. The identity carries the job's role, project and items
 * from the job row, never from the request.
 */
export async function jobIdentityOf(
  c: WorkerContext<ApiEnv>,
  token: string,
  logger: Logger,
): Promise<Identity | Response> {
  const runnerJwt = runnerJwtOf(c.req.header(RUNNER_JWT_HEADER), true);
  if (runnerJwt === null) {
    return refusalResponse(c, logger, { type: 'job-runner-missing', status: 401 });
  }
  const verification = await verifyRunnerJwt(c, runnerJwt);
  if (!verification.ok) {
    return runnerRefusal(c, logger, verification);
  }
  const now = new Date();
  const tokenHash = await sha256Hex(token);
  const job = await new JobsRepo(c.env.DB).findByTokenHash(tokenHash);
  const refusal = judgeJob(job, verification.runner.id, verification.runner.allowedProjects, now);
  if (refusal !== null || job === null) {
    return refusalResponse(c, logger, refusal ?? { type: 'job-token-invalid', status: 401 });
  }
  if (!isJobRole(job.role)) {
    // A role the matrix has no row for never becomes an identity (fail closed).
    return refusalResponse(c, logger, { type: 'job-token-invalid', status: 401 });
  }
  await recordSighting(c, verification.runner, logger, now);
  const items = job.payload['items'];
  return {
    kind: 'job',
    role: job.role,
    projectSlug: job.projectSlug,
    jobId: job.id,
    items: Array.isArray(items) ? items.filter((n): n is number => typeof n === 'number') : [],
    // Equal to `job.runnerId`: `judgeJob` refused any other.
    runnerId: verification.runner.id,
    source: 'token',
    tokenHash,
  };
}

/**
 * What a tracker write under a job token must still find when its batch commits (#580), or `null` for any other
 * identity (the owner, a member, the local stand-in), whose writes carry no such guard.
 */
export function jobTokenHoldOf(identity: Identity, at: Date): JobTokenHold | null {
  if (identity.kind !== 'job' || identity.source !== 'token') {
    return null;
  }
  // A token identity without its hash cannot be judged; an empty hash names no job, so the guard refuses.
  return { tokenHash: identity.tokenHash ?? '', jobId: identity.jobId, at: at.toISOString() };
}

/**
 * The answer for a job-token write whose batch failed (#580), or `null` when the job still holds and the failure
 * was something else. Re-reads the stored runner and job, so a revoke answers as the runner door does (401
 * `runner-revoked`) and a narrowing or a cleared token as authentication would on the next call. Read only on this
 * failure path, never per write.
 */
export async function lostJobHoldRefusal(
  c: WorkerContext<ApiEnv>,
  identity: JobIdentity,
  logger: Logger,
): Promise<Response | null> {
  const [runner, job] = await Promise.all([
    identity.runnerId === undefined ? null : new RunnersRepo(c.env.DB).findById(identity.runnerId),
    identity.tokenHash === undefined ? null : new JobsRepo(c.env.DB).findByTokenHash(identity.tokenHash),
  ]);
  if (runner === null || runner.revokedAt !== null) {
    logger.warn('runner rejected', { reason: 'runner-revoked' });
    return problem(c, { type: 'runner-revoked', title: 'Unauthorized', status: 401 });
  }
  const sameJob = job !== null && job.id === identity.jobId && job.accountId === runner.accountId ? job : null;
  const refusal = judgeJob(sameJob, runner.id, runner.allowedProjects, new Date());
  return refusal === null ? null : refusalResponse(c, logger, refusal);
}
