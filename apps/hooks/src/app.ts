import type { Hono } from 'hono';
import { createWorkerApp, type LogSink, type WorkerHonoEnv } from '@worker/core';
import type { HooksEnv } from './env';
import { noopPushSender, type PushSender } from './push/push-sender';
import { githubWebhookRoutes } from './routes/github';
import { healthzRoutes } from './routes/healthz';

export interface CreateHooksAppOptions {
  readonly logSink?: LogSink;
  /** #11's sender once it is wired in; until then mapped pushes are dropped (the no-op sender). */
  readonly pushSender?: PushSender;
  /** Test seam for the delivery clock. */
  readonly now?: () => Date;
}

/** The public `hooks` Worker: `/healthz` and `POST /hooks/github` (#12). Everything else is a JSON 404. */
export function createHooksApp(options: CreateHooksAppOptions = {}): Hono<WorkerHonoEnv<HooksEnv>> {
  const app = createWorkerApp<HooksEnv>({
    service: 'hooks',
    ...(options.logSink === undefined ? {} : { logSink: options.logSink }),
  });

  app.route('/healthz', healthzRoutes);
  app.route(
    '/hooks/github',
    githubWebhookRoutes({
      pushSender: options.pushSender ?? noopPushSender,
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
  );

  return app;
}
