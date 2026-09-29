import { Hono } from 'hono';
import type { PublicHealthDto } from '@shared/contracts';
import type { WorkerHonoEnv } from '@worker/core';
import type { HooksEnv } from '../env';

/** Public and unauthenticated: liveness only, no environment or version (threat model on #12). */
export const healthzRoutes = new Hono<WorkerHonoEnv<HooksEnv>>().get('/', (c) => {
  const body: PublicHealthDto = { status: 'ok' };
  return c.json(body);
});
