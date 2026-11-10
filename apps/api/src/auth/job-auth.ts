import { problem, sha256Hex, type Logger, type WorkerContext } from '@worker/core';
import { JobsRepo } from '@worker/db';
import type { ApiEnv } from '../env';
import type { Identity } from './auth.types';
import { isJobRole } from './job-roles';
import { RUNNER_JWT_HEADER, recordSighting, runnerJwtOf, runnerRefusal, verifyRunnerJwt } from './runner-auth';

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
  const refuse = (type: string, status: 401 | 403): Response => {
    logger.warn('job token rejected', { reason: type });
    return problem(c, { type, title: status === 401 ? 'Unauthorized' : 'Forbidden', status });
  };
  const runnerJwt = runnerJwtOf(c.req.header(RUNNER_JWT_HEADER), true);
  if (runnerJwt === null) {
    return refuse('job-runner-missing', 401);
  }
  const verification = await verifyRunnerJwt(c, runnerJwt);
  if (!verification.ok) {
    return runnerRefusal(c, logger, verification);
  }
  const now = new Date();
  const job = await new JobsRepo(c.env.DB).findByTokenHash(await sha256Hex(token));
  if (job === null) {
    return refuse('job-token-invalid', 401);
  }
  // The runner's allow-list is judged again here (#490 review): a project removed from it after the claim closes
  // the job's door at once, whatever the cancel batch managed.
  if (job.runnerId !== verification.runner.id || !verification.runner.allowedProjects.includes(job.projectSlug)) {
    return refuse('job-runner-mismatch', 403);
  }
  if (
    (job.state !== 'claimed' && job.state !== 'running') ||
    job.leaseUntil === null ||
    job.leaseUntil < now.toISOString()
  ) {
    return refuse('job-lease-expired', 401);
  }
  if (!isJobRole(job.role)) {
    // A role the matrix has no row for never becomes an identity (fail closed).
    return refuse('job-token-invalid', 401);
  }
  await recordSighting(c, verification.runner, logger, now);
  const items = job.payload['items'];
  return {
    kind: 'job',
    role: job.role,
    projectSlug: job.projectSlug,
    jobId: job.id,
    items: Array.isArray(items) ? items.filter((n): n is number => typeof n === 'number') : [],
    source: 'token',
  };
}
