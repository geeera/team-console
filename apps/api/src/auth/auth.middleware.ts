import type { MiddlewareHandler } from 'hono';
import { problem, type WorkerHonoEnv } from '@worker/core';
import type { ApiEnv } from '../env';
import { readAccessConfig } from './access-config';
import { identityOf, verifyAccessJwt } from './access-jwt';
import type { Identity } from './auth.types';
import { isLocalBypass } from './local-bypass';
import { bearerOf, parseLocalJobToken } from './local-job';
import {
  isEnrolRequest,
  isRunnerPath,
  recordSighting,
  runnerIdentityOf,
  runnerJwtOf,
  runnerRefusal,
  verifyRunnerJwt,
} from './runner-auth';
import { accessOwnerIdentityOf, sessionIdentityOf } from './session';

const ACCESS_HEADER = 'Cf-Access-Jwt-Assertion';

/**
 * Cloudflare Access JWT check on every `/api/*` request (ADR 0001 decision 7, threat model on #8). Access at the
 * edge is not trusted to be on or correctly configured: only a verified token for the owner (or the pinned
 * service token on dev/stage) gets through. Every other outcome is a 401 problem; the redirect to the Access
 * login is Access's job, not ours. Only the header is read — the `CF_Authorization` cookie is not accepted.
 *
 * The local bypass needs both flags; they are passed only as `--var` by `nx serve api` and the Dockerfile, never
 * from an `env.*` block (tools/workspace-checks). Under it a request is the owner (`local`), or the job its
 * `Authorization: Bearer local-job.…` stand-in names (#444).
 *
 * Before the Access check, a live `__Host-tc_session` cookie is the console's own door (ADR 0008 decision 3, #466):
 * its user and memberships come from D1. A cookie that is not a live session grants nothing and the request goes
 * on to the Access check, so a stale cookie never locks the owner out and a forged one never gets in.
 */
export const authMiddleware: MiddlewareHandler<WorkerHonoEnv<ApiEnv>> = async (c, next) => {
  const logger = c.get('logger');
  const grant = async (identity: Identity): Promise<void> => {
    c.set('identity', identity);
    logger.info('access granted', { identity: identity.kind });
    await next();
  };

  // The runner's door (#467): on `/api/v1/runner/*` the runner JWT is the only credential, whatever else the request
  // carries — the local bypass, a session cookie and the Access header are not read there. Enrolment has no
  // identity yet; the code in its body is judged by the route.
  if (isRunnerPath(c.req.path)) {
    if (isEnrolRequest(c.req.method, c.req.path)) {
      await grant({ kind: 'enrolment' });
      return;
    }
    const token = runnerJwtOf(c.req.header('Authorization'));
    if (token === null) {
      logger.warn('runner rejected', { reason: 'runner-jwt-missing' });
      return problem(c, { type: 'runner-jwt-missing', title: 'Unauthorized', status: 401 });
    }
    const verification = await verifyRunnerJwt(c, token);
    if (!verification.ok) {
      return runnerRefusal(c, logger, verification);
    }
    await recordSighting(c, verification.runner, logger);
    await grant(runnerIdentityOf(verification.runner));
    return;
  }

  const bearer = bearerOf(c.req.header('Authorization'));
  if (isLocalBypass(c.env)) {
    if (bearer.kind === 'none') {
      await grant({ kind: 'local' });
      return;
    }
    // A header that is not a well-formed stand-in is refused rather than read as the owner: a job whose token is
    // wrong must not quietly get the owner's rights.
    const job = bearer.kind === 'local-job' ? parseLocalJobToken(bearer.token) : null;
    if (job === null) {
      logger.warn('access rejected', { reason: 'job-token-invalid' });
      return problem(c, { type: 'job-token-invalid', title: 'Unauthorized', status: 401 });
    }
    await grant(job);
    return;
  }

  // #444: the stand-in exists only under the local bypass. Anywhere else it is refused outright — never ignored, so a
  // job script pointed at a deployed console cannot ride an owner's Access session either.
  if (bearer.kind === 'local-job') {
    logger.warn('access rejected', { reason: 'job-token-refused' });
    return problem(c, { type: 'job-token-refused', title: 'Unauthorized', status: 401 });
  }

  const session = await sessionIdentityOf(c, logger);
  if (session !== null) {
    await grant(session);
    return;
  }

  const configResult = readAccessConfig(c.env);
  if (!configResult.ok) {
    // Names of the bad bindings only; their values may be private (OWNER_EMAIL is a secret).
    logger.error('access misconfigured', { invalid: configResult.invalid });
    return problem(c, { type: 'access-misconfigured', title: 'Unauthorized', status: 401 });
  }
  const { config } = configResult;

  const token = c.req.header(ACCESS_HEADER)?.trim() ?? '';
  if (token === '') {
    logger.warn('access rejected', { reason: 'access-missing' });
    return problem(c, { type: 'access-missing', title: 'Unauthorized', status: 401 });
  }

  const verification = await verifyAccessJwt(token, config);
  if (!verification.ok) {
    const fields = { reason: 'access-unverified', code: verification.code };
    if (verification.expected) {
      logger.warn('access rejected', fields);
    } else {
      logger.error('access rejected', fields);
    }
    return problem(c, { type: 'access-unverified', title: 'Unauthorized', status: 401 });
  }

  const decision = identityOf(verification.payload, config);
  if (!decision.ok) {
    logger.warn('access rejected', { reason: 'access-forbidden', detail: decision.reason });
    return problem(c, { type: 'access-forbidden', title: 'Unauthorized', status: 401 });
  }
  const identity =
    decision.identity.kind === 'user' && decision.identity.door === 'access'
      ? await accessOwnerIdentityOf(c, decision.accessSubject)
      : decision.identity;
  await grant(identity);
  return;
};
