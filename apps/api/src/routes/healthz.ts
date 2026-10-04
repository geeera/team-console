import { Hono } from 'hono';
import { isEnvironment, type HealthDto } from '@shared/contracts';
import { problem, type WorkerHonoEnv } from '@worker/core';
import { buildInfo } from '../build-info';
import type { ApiEnv } from '../env';

/** Behind Access, so environment and version may be shown (the public hooks Worker shows neither). */
export const healthzRoutes = new Hono<WorkerHonoEnv<ApiEnv>>().get('/', (c) => {
  const environment: string = c.env.ENVIRONMENT;
  if (!isEnvironment(environment)) {
    return problem(c, {
      type: 'misconfigured',
      title: 'ENVIRONMENT is not one of local, dev, stage, production',
      status: 500,
    });
  }
  const body: HealthDto = { status: 'ok', environment, version: buildInfo.version };
  return c.json(body);
});
