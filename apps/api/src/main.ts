import { createLogger } from '@worker/core';
import { sweepQueue } from './actions/sweep';
import { createApiApp } from './app';
import type { ApiEnv } from './env';

const app = createApiApp();

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  // The Cron Trigger (#670): the queue's sweep. A failure is logged, never left as an unhandled rejection.
  scheduled: (controller, env, ctx) => {
    const logger = createLogger({ service: 'api', component: 'cron' });
    ctx.waitUntil(
      (async () => {
        try {
          await sweepQueue(env, new Date(controller.scheduledTime), logger);
        } catch (error: unknown) {
          logger.error('queue sweep failed', { error: error instanceof Error ? error.name : 'unknown' });
          throw error;
        }
      })(),
    );
  },
} satisfies ExportedHandler<ApiEnv>;
