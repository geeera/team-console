import { Hono } from 'hono';
import {
  RUNNER_POLL_SECONDS,
  checkEnrolRunnerInput,
  isRunnerVersion,
  runnerAudienceOf,
  type EnrolRunnerResponse,
  type RunnerReleaseDto,
} from '@shared/contracts';
import { ENROLMENT_CODE_PREFIX, OPAQUE_TOKEN_TAIL } from '@shared/redaction';
import {
  newUlid,
  problem,
  sha256Hex,
  timingSafeEqualText,
  type ProblemExtensionValue,
  type WorkerContext,
  type WorkerHonoEnv,
} from '@worker/core';
import { AccountsRepo, RateLimitsRepo, RunnersRepo, rateWindowOf, retryAfterOf } from '@worker/db';
import type { ApiEnv } from '../env';
import { jsonBody } from '../json-body';
import { SMALL_WRITE_MAX_BYTES, writeLimit } from '../tracker/http';

type Context = WorkerContext<ApiEnv>;

/** Enrol attempts per source address per minute (ADR 0006 "Enrolment": rate-limited per IP; D1 counters, #467). */
export const ENROL_RATE_LIMIT_PER_MINUTE = 10;
/**
 * Enrol attempts for the whole environment per minute: a floor under a distributed guess (against 256 random bits
 * any rate is hopeless; the floor bounds the D1 writes a flood costs).
 */
export const ENROL_RATE_LIMIT_GLOBAL_PER_MINUTE = 300;
const ENROLMENT_CODE = new RegExp(`^${ENROLMENT_CODE_PREFIX}${OPAQUE_TOKEN_TAIL}$`);

/** The release the environment names (vars); an unset or malformed var is `null`, never a guess. */
export function runnerReleaseOf(env: Pick<ApiEnv, 'RUNNER_RELEASE_VERSION' | 'RUNNER_MINIMUM_VERSION'>): RunnerReleaseDto {
  return {
    version: isRunnerVersion(env.RUNNER_RELEASE_VERSION) ? env.RUNNER_RELEASE_VERSION : null,
    minimumVersion: isRunnerVersion(env.RUNNER_MINIMUM_VERSION) ? env.RUNNER_MINIMUM_VERSION : null,
  };
}

function codeInvalid(c: Context, reason: string): Response {
  // One answer for a malformed, unknown, expired or used code: nothing about codes is enumerable (threat model C4).
  c.get('logger').warn('enrolment refused', { reason });
  return problem(c, {
    type: 'enrolment-code-invalid',
    title: 'Unauthorized',
    status: 401,
    detail: 'The enrolment code is not valid: ask the account owner for a new one',
  });
}

/**
 * `POST /api/v1/runner/enrol` and `GET /api/v1/runner/release` (#467, ADR 0008 row 2-A; ADR 0006 "Enrolment"). The
 * enrol request carries the one-time code (256 random bits, 10 minutes, hashed in D1 and compared in constant time)
 * and the runner's half of the record — its Ed25519 public key, host, capabilities, backend and version; the name
 * and the allowed projects are the owner's, fixed when the code was made. The real controls where no WAF rule
 * applies (workers.dev has no zone): the code's entropy, single use at the row, and D1 rate counters per address and
 * for the environment.
 */
export function createRunnerRoutes(): Hono<WorkerHonoEnv<ApiEnv>> {
  return new Hono<WorkerHonoEnv<ApiEnv>>()
    .post('/enrol', writeLimit(SMALL_WRITE_MAX_BYTES), async (c) => {
      const logger = c.get('logger');
      const now = new Date();
      const limits = new RateLimitsRepo(c.env.DB);
      const window = rateWindowOf(now.getTime(), 60);
      const ip = c.req.header('CF-Connecting-IP')?.trim() ?? '';
      const perAddress = await limits.hit(
        `enrol:ip:${ip === '' ? 'unknown' : await sha256Hex(ip)}`,
        window,
        ENROL_RATE_LIMIT_PER_MINUTE,
      );
      const global = await limits.hit('enrol:all', window, ENROL_RATE_LIMIT_GLOBAL_PER_MINUTE);
      if (!perAddress.allowed || !global.allowed) {
        logger.warn('enrolment refused', { reason: 'rate-limited', scope: perAddress.allowed ? 'all' : 'ip' });
        return problem(c, {
          type: 'rate-limited',
          title: 'Too Many Requests',
          status: 429,
          retryAfter: retryAfterOf(now.getTime(), 60),
        });
      }

      const input = checkEnrolRunnerInput(await jsonBody(c));
      if (!input.ok) {
        const extensions: Record<string, ProblemExtensionValue> = { field: input.field };
        return problem(c, {
          type: 'enrol-invalid',
          title: 'Invalid request',
          status: 422,
          detail: input.detail,
          extensions,
        });
      }
      const { value } = input;
      if (!ENROLMENT_CODE.test(value.code)) {
        return codeInvalid(c, 'code-malformed');
      }
      const runners = new RunnersRepo(c.env.DB);
      const codeHash = await sha256Hex(value.code);
      const enrolment = await runners.findEnrolment(codeHash);
      // The equality in SQL already decided; the constant-time compare keeps the answer's timing flat on top of it.
      if (enrolment === null || !timingSafeEqualText(enrolment.codeHash, codeHash)) {
        return codeInvalid(c, 'code-unknown');
      }
      if (enrolment.usedByRunnerId !== null) {
        return codeInvalid(c, 'code-used');
      }
      if (enrolment.expiresAt <= now.toISOString()) {
        return codeInvalid(c, 'code-expired');
      }
      const account = await new AccountsRepo(c.env.DB).findById(enrolment.accountId);
      if (account === null || account.suspendedAt !== null) {
        logger.warn('enrolment refused', { reason: 'account-suspended' });
        return problem(c, { type: 'account-suspended', title: 'Forbidden', status: 403 });
      }
      // ADR 0008 decision 8: `none` is for fixture environments; production never enrols one.
      if (value.isolation === 'none' && c.env.ENVIRONMENT === 'production') {
        logger.warn('enrolment refused', { reason: 'isolation-none' });
        return problem(c, {
          type: 'runner-isolation-none',
          title: 'Unprocessable Content',
          status: 422,
          detail: 'A runner without isolation cannot serve production; choose container or user',
          extensions: { field: 'isolation' },
        });
      }

      const runnerId = newUlid(now.getTime());
      const at = now.toISOString();
      const outcome = await runners.enrol(
        codeHash,
        {
          id: runnerId,
          accountId: enrolment.accountId,
          name: enrolment.name,
          publicKeyJwk: value.publicKey,
          host: value.host,
          capabilities: value.capabilities,
          isolation: value.isolation,
          allowedProjects: enrolment.allowedProjects,
          version: value.version,
          at,
        },
        {
          accountId: enrolment.accountId,
          at,
          actorKind: 'runner',
          actor: runnerId,
          kind: 'runner.enrolled',
          target: runnerId,
          details: {
            name: enrolment.name,
            isolation: value.isolation,
            version: value.version,
            allowedProjects: enrolment.allowedProjects,
            createdBy: enrolment.createdBy,
          },
          ipCountry: c.req.header('CF-IPCountry') ?? null,
        },
      );
      if (outcome === 'code-used') {
        return codeInvalid(c, 'code-used');
      }
      logger.info('runner enrolled', { runnerId, isolation: value.isolation });
      const body: EnrolRunnerResponse = {
        runnerId,
        accountId: enrolment.accountId,
        name: enrolment.name,
        audience: runnerAudienceOf(c.env.ENVIRONMENT),
        allowedProjects: enrolment.allowedProjects,
        pollSeconds: RUNNER_POLL_SECONDS,
      };
      return c.json(body, 201);
    })

    .get('/release', (c) => c.json(runnerReleaseOf(c.env)));
}
