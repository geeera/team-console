import type { Hono } from 'hono';
import { createWorkerApp, type LogSink, type WorkerHonoEnv } from '@worker/core';
import type { HooksEnv } from './env';
import type { FetchLike } from '@worker/push';
import { webPushSenders, type NotificationSenderFactory } from './push/push-sender';
import { githubWebhookRoutes } from './routes/github';
import { healthzRoutes } from './routes/healthz';

export interface CreateHooksAppOptions {
  readonly logSink?: LogSink;
  /** Transport of the web push sender; tests pass the fake push service. Defaults to the global `fetch`. */
  readonly pushFetch?: FetchLike;
  /** Replaces the whole sender (tests of a failing fan-out). */
  readonly senders?: NotificationSenderFactory;
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
      senders:
        options.senders ?? webPushSenders(options.pushFetch ?? (async (input, init) => fetch(input, init))),
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
  );

  return app;
}
