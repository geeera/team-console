import { Hono } from 'hono';
import {
  JOB_LEASE_SECONDS,
  actionsRunnerNameOf,
  checkOidcExchangeInput,
  runnerAudienceOf,
  type OidcExchangeClaim,
  type OidcExchangeResponse,
} from '@shared/contracts';
import { JOB_TOKEN_PREFIX } from '@shared/redaction';
import {
  newUlid,
  problem,
  randomOpaqueToken,
  sha256Hex,
  type Logger,
  type ProblemExtensionValue,
  type WorkerContext,
  type WorkerHonoEnv,
} from '@worker/core';
import { JobsRepo, type NewAuditEvent } from '@worker/db';
import { actionsClaimRefusalOf, isTargetRepository, repositoryIdOf, verifyActionsOidcToken } from '../auth/actions-oidc';
import { DoorRateLimits, type DoorLimitScope } from '../auth/door-rate-limits';
import { sightingOf } from '../auth/runner-auth';
import type { ApiEnv } from '../env';
import { jsonBody } from '../json-body';
import { SMALL_WRITE_MAX_BYTES, writeLimit } from '../tracker/http';
import { claimTeamConfigOf } from '../team-config/resolved';
import { jobDtoOf } from './jobs';

type Context = WorkerContext<ApiEnv>;

/** Exchanges per source address per minute: a run exchanges once, so this is generous for any honest caller. */
export const OIDC_EXCHANGE_RATE_LIMIT_PER_MINUTE = 10;
/** Exchanges per repository per minute, counted only for tokens GitHub signed (an unsigned one names no repository). */
export const OIDC_EXCHANGE_RATE_LIMIT_PER_REPOSITORY_PER_MINUTE = 10;
/** The floor for the whole environment, as for `enrol`, counted only for tokens GitHub signed (#696). */
export const OIDC_EXCHANGE_RATE_LIMIT_GLOBAL_PER_MINUTE = 300;
/**
 * Requests refused before their token held (malformed body, bad signature or claims) for the whole environment: a
 * bucket of their own (#696), so junk from rotating addresses never spends the budget of real exchanges.
 */
export const OIDC_EXCHANGE_RATE_LIMIT_UNVERIFIED_PER_MINUTE = 300;

const REFUSAL_TITLES = { 401: 'Unauthorized', 403: 'Forbidden', 409: 'Conflict' } as const;

const REFUSAL_DETAILS = {
  403: 'The project runs on a subscription, which never runs on a GitHub Actions machine',
  409: 'The job is not waiting for a GitHub Actions run',
} as const;

/**
 * Every refusal of a token, a claim or the job is this one problem (#668): `extensions.claim` names what failed, never
 * a value of the token. The log carries the claim and the job id the body named, never the token.
 */
function refused(c: Context, logger: Logger, claim: OidcExchangeClaim, status: 401 | 403 | 409, jobId: string | null): Response {
  logger.warn('oidc exchange refused', { claim, ...(jobId === null ? {} : { jobId }) });
  const extensions: Record<string, ProblemExtensionValue> = { claim };
  return problem(c, {
    type: 'oidc-exchange-refused',
    title: REFUSAL_TITLES[status],
    status,
    detail: status === 401 ? `The GitHub Actions token does not hold for this job: ${claim}` : REFUSAL_DETAILS[status],
    extensions,
  });
}

function rateLimited(c: Context, logger: Logger, scope: DoorLimitScope | 'repository', limits: DoorRateLimits): Response {
  logger.warn('oidc exchange refused', { reason: 'rate-limited', scope });
  return problem(c, { type: 'rate-limited', title: 'Too Many Requests', status: 429, retryAfter: limits.retryAfter() });
}

/**
 * `POST /api/v1/runner/oidc-exchange` (#668; architect note on #573 sections 1–2, ADR 0008 decision 7(a′), threat
 * model C11 row 5). A GitHub-hosted workflow run, dispatched for one job, presents its OIDC token and a key it made in
 * memory; the console verifies the token (`auth/actions-oidc.ts`) and every claim against the job's project, then
 * writes an `actions-ephemeral` runner for exactly that job and claims the job for it in one batch. The answer is the
 * claim's (`ClaimResponse`) plus the runner id and audience the run signs its runner JWTs with; from there the run
 * uses the ordinary runner and job routes, and `finish` (or the lease sweep) revokes the identity.
 */
export function createRunnerOidcRoutes(): Hono<WorkerHonoEnv<ApiEnv>> {
  return new Hono<WorkerHonoEnv<ApiEnv>>().post('/oidc-exchange', writeLimit(SMALL_WRITE_MAX_BYTES), async (c) => {
    const logger = c.get('logger');
    const now = new Date();
    const limits = new DoorRateLimits(c.env.DB, 'oidc', now.getTime());
    if (!(await limits.hitAddress(c.req.header('CF-Connecting-IP'), OIDC_EXCHANGE_RATE_LIMIT_PER_MINUTE, logger))) {
      return rateLimited(c, logger, 'ip', limits);
    }
    // A refusal before the token held counts in the junk bucket; once that is over, junk is answered 429 instead.
    const junk = async (refusal: () => Response): Promise<Response> =>
      (await limits.hitUnverified(OIDC_EXCHANGE_RATE_LIMIT_UNVERIFIED_PER_MINUTE))
        ? refusal()
        : rateLimited(c, logger, 'unverified', limits);

    const input = checkOidcExchangeInput(await jsonBody(c));
    if (!input.ok) {
      const extensions: Record<string, ProblemExtensionValue> = { field: input.field };
      return junk(() =>
        problem(c, { type: 'oidc-exchange-invalid', title: 'Invalid request', status: 422, detail: input.detail, extensions }),
      );
    }
    const { value } = input;

    const verification = await verifyActionsOidcToken(c.env, value.idToken, now);
    if (!verification.ok) {
      const { claim } = verification;
      if (claim === null) {
        logger.error('oidc issuer unavailable');
        return problem(c, { type: 'oidc-issuer-unavailable', title: 'Service Unavailable', status: 503, retryAfter: 30 });
      }
      return junk(() => refused(c, logger, claim, 401, value.jobId));
    }
    const { claims } = verification;
    const repositoryId = repositoryIdOf(claims);
    if (repositoryId === null) {
      return junk(() => refused(c, logger, 'repository_id', 401, value.jobId));
    }
    // GitHub signs a token for any repository and any audience (#729 security review): only a token tied to the job's
    // registered repository may spend the verified budget, so an unknown job or a foreign repository is junk too.
    const jobs = new JobsRepo(c.env.DB);
    const target = await jobs.findActionsTarget(value.jobId);
    if (target === null) {
      return junk(() => refused(c, logger, 'job_id', 401, value.jobId));
    }
    if (!isTargetRepository(claims, target)) {
      return junk(() => refused(c, logger, 'repository_id', 401, value.jobId));
    }
    if (!(await limits.hit(`repo:${repositoryId}`, OIDC_EXCHANGE_RATE_LIMIT_PER_REPOSITORY_PER_MINUTE))) {
      return rateLimited(c, logger, 'repository', limits);
    }
    if (!(await limits.hitVerified(OIDC_EXCHANGE_RATE_LIMIT_GLOBAL_PER_MINUTE))) {
      return rateLimited(c, logger, 'verified', limits);
    }

    const claim = actionsClaimRefusalOf(claims, target);
    if (claim !== null) {
      return refused(c, logger, claim, 401, value.jobId);
    }
    // `actionsClaimRefusalOf` checked its shape; a run id is a decimal string.
    const runId = String(claims['run_id']);
    if (await jobs.isActionsRunSeen(runId)) {
      return refused(c, logger, 'run_id', 401, value.jobId);
    }
    const { job } = target;
    if (job.dispatch !== 'actions' || job.state !== 'queued' || job.runnerId !== null) {
      return refused(c, logger, 'job_id', 409, value.jobId);
    }
    // #723 item 2: only the run the console's dispatch started, as GitHub named it, may take the job. A run started
    // by hand with the same `job_id` input carries every other claim the console's run does; its `run_id` it cannot.
    // A job whose dispatch never recorded a run (never dispatched, or the Worker died before the call) is taken by no
    // run at all. The batch below holds the same term in its write.
    if (target.dispatchedRunId !== runId) {
      return refused(c, logger, 'run_id', 401, value.jobId);
    }

    const at = now.toISOString();
    const runnerId = newUlid(now.getTime());
    const runnerName = actionsRunnerNameOf(runId);
    const token = randomOpaqueToken(JOB_TOKEN_PREFIX);
    const sighting = await sightingOf(c, at);
    const audit = (kind: NewAuditEvent['kind'], target: string, details: Readonly<Record<string, unknown>>): NewAuditEvent => ({
      accountId: job.accountId,
      at,
      actorKind: 'runner',
      actor: runnerId,
      kind,
      target,
      details,
      ipCountry: sighting.country,
    });
    const outcome = await jobs.exchangeForActions({
      jobId: job.id,
      runId,
      runnerId,
      runnerName,
      publicKeyJwk: value.publicKey,
      host: value.host,
      version: value.version,
      tokenHash: await sha256Hex(token),
      now: at,
      leaseUntil: new Date(now.getTime() + JOB_LEASE_SECONDS * 1000).toISOString(),
      country: sighting.country,
      ipHash: sighting.ipHash,
      enrolledAudit: audit('runner.enrolled', runnerId, {
        name: runnerName,
        isolation: 'actions-ephemeral',
        version: value.version,
        allowedProjects: [job.projectSlug],
        via: 'oidc-exchange',
        jobId: job.id,
        runId,
      }),
      claimedAudit: audit('job.claimed', job.id, {
        kind: job.kind,
        slug: job.projectSlug,
        attempt: job.attempt + 1,
        country: sighting.country,
        via: 'actions',
        runId,
      }),
    });
    if (outcome.kind === 'run-seen') {
      return refused(c, logger, 'run_id', 401, job.id);
    }
    if (outcome.kind === 'not-claimable') {
      return refused(c, logger, 'job_id', 409, job.id);
    }
    // ADR 0009 d.3 (#682): judged inside the batch, so a source switched to `subscription` before it commits wins.
    if (outcome.kind === 'access-source') {
      return refused(c, logger, 'access_source', 403, job.id);
    }
    logger.info('oidc exchange claimed a job', { jobId: job.id, runnerId, runId });
    const body: OidcExchangeResponse = {
      job: jobDtoOf(outcome.job),
      jobToken: token,
      leaseSeconds: JOB_LEASE_SECONDS,
      // #775: the identity exists for this one project; the run holds itself to exactly that.
      scope: { projectScope: 'selected', allowedProjects: [job.projectSlug], projects: [job.projectSlug] },
      // #687: the revision the exchange stamped, as for the pull claim; #669's run reads its settings from here.
      ...(await claimTeamConfigOf(c.env.DB, outcome.job)),
      runner: { id: runnerId, audience: runnerAudienceOf(c.env.ENVIRONMENT) },
    };
    return c.json(body);
  });
}
