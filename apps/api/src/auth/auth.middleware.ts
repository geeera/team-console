import type { MiddlewareHandler } from 'hono';
import { problem, type WorkerHonoEnv } from '@worker/core';
import type { ApiEnv } from '../env';

/**
 * Fails closed until #8 adds Access JWT verification: every `/api/*` request is 401 unless the local
 * bypass is on. The bypass needs both flags (threat model on #8, row 7) and they are passed only as
 * `--var` by `nx serve api` and the Dockerfile — never from an `env.*` block (tools/workspace-checks).
 * #8 replaces the 401 branch with the JWT check and keeps this local condition.
 */
export const authMiddleware: MiddlewareHandler<WorkerHonoEnv<ApiEnv>> = async (c, next) => {
  if (c.env.ENVIRONMENT === 'local' && c.env.AUTH_MODE === 'local') {
    await next();
    return;
  }
  return problem(c, { type: 'access-missing', title: 'Unauthorized', status: 401 });
};
