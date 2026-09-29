import type { Hono } from 'hono';
import { createWorkerApp, type LogSink, type WorkerHonoEnv } from '@worker/core';
import type { HooksEnv } from './env';
import { healthzRoutes } from './routes/healthz';

export interface CreateHooksAppOptions {
  readonly logSink?: LogSink;
}

/** The `hooks` Worker: `/healthz` now, `POST /hooks/github` with #12. Everything else is a JSON 404. */
export function createHooksApp(options: CreateHooksAppOptions = {}): Hono<WorkerHonoEnv<HooksEnv>> {
  const app = createWorkerApp<HooksEnv>({
    service: 'hooks',
    ...(options.logSink === undefined ? {} : { logSink: options.logSink }),
  });

  app.route('/healthz', healthzRoutes);

  return app;
}
