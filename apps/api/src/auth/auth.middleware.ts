import type { MiddlewareHandler } from 'hono';
import { problem, type WorkerHonoEnv } from '@worker/core';
import type { ApiEnv } from '../env';
import { readAccessConfig } from './access-config';
import { identityOf, verifyAccessJwt } from './access-jwt';
import type { Identity } from './auth.types';

const ACCESS_HEADER = 'Cf-Access-Jwt-Assertion';

/**
 * Cloudflare Access JWT check on every `/api/*` request (ADR 0001 decision 7, threat model on #8). Access at the
 * edge is not trusted to be on or correctly configured: only a verified token for the owner (or the pinned
 * service token on dev/stage) gets through. Every other outcome is a 401 problem; the redirect to the Access
 * login is Access's job, not ours. Only the header is read — the `CF_Authorization` cookie is not accepted.
 *
 * The local bypass needs both flags; they are passed only as `--var` by `nx serve api` and the Dockerfile, never
 * from an `env.*` block (tools/workspace-checks).
 */
export const authMiddleware: MiddlewareHandler<WorkerHonoEnv<ApiEnv>> = async (c, next) => {
  const logger = c.get('logger');
  const grant = async (identity: Identity): Promise<void> => {
    c.set('identity', identity);
    logger.info('access granted', { identity: identity.kind });
    await next();
  };

  if (c.env.ENVIRONMENT === 'local' && c.env.AUTH_MODE === 'local') {
    await grant({ kind: 'local' });
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
  await grant(decision.identity);
  return;
};
