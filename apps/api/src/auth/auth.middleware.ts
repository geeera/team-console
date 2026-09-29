import type { MiddlewareHandler } from 'hono';
import type { WorkerHonoEnv } from '@worker/core';
import type { ApiEnv } from '../env';

/**
 * Placeholder mounted once on `/api/*`; #8 replaces the body with Access JWT verification (fail closed).
 * Until then every request passes — auth.middleware.spec.ts fails by default so this cannot reach stage unnoticed.
 */
export const authMiddleware: MiddlewareHandler<WorkerHonoEnv<ApiEnv>> = async (_c, next) => {
  await next();
};
