import { createLogger } from '@worker/core';
import { sweepQueue } from './actions/sweep';
import { createApiApp } from './app';
import type { ApiEnv } from './env';
import { ApiGitHub } from './github';

// One per isolate, shared by the app and the Cron sweep's dispatches (#716), so both reuse its caches.
const github = new ApiGitHub();
const app = createApiApp({ github });

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  // The Cron Trigger (#670): the queue's sweep. A failure is logged, never left as an unhandled rejection.
  scheduled: (controller, env, ctx) => {
    const logger = createLogger({ service: 'api', component: 'cron' });
    ctx.waitUntil(
      (async () => {
        try {
          await sweepQueue(env, new Date(controller.scheduledTime), logger, github);
        } catch (error: unknown) {
          logger.error('queue sweep failed', { error: error instanceof Error ? error.name : 'unknown' });
          throw error;
        }
      })(),
    );
  },
} satisfies ExportedHandler<ApiEnv>;
