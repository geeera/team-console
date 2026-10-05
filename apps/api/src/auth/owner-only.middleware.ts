import type { MiddlewareHandler } from 'hono';
import { problem, type WorkerHonoEnv } from '@worker/core';
import type { ApiEnv } from '../env';

/**
 * Routes that act for the owner's GitHub account — the connection routes (#59), push (#11) and the team commands
 * (#114) — are for the owner only: the dev/stage CI service token passes `authMiddleware` but must not start, read
 * or revoke the owner's connection (#85) nor write as the owner (#62). The answer route is the one owner write the
 * service identity may reach, and only on a fixture issue (`service-write-gate.ts`). `user` (the owner's Access
 * login) and `local` (the local bypass) pass.
 */
export const ownerOnlyMiddleware: MiddlewareHandler<WorkerHonoEnv<ApiEnv>> = async (c, next) => {
  if (c.get('identity').kind === 'service') {
    c.get('logger').warn('owner route refused', {
      reason: 'service-identity',
      method: c.req.method,
      path: c.req.path,
    });
    return problem(c, {
      type: 'owner-only',
      title: 'Forbidden',
      status: 403,
      detail: 'Only the owner can use this route',
    });
  }
  await next();
  return;
};
