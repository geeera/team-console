import { createLogger } from '@worker/core';
import { runLoggedSweep, sweepEnrolmentIntents, sweepQueue } from './actions/sweep';
import { createApiApp } from './app';
import type { ApiEnv } from './env';
import { ApiGitHub } from './github';

// One per isolate, shared by the app and the Cron sweep's dispatches (#716), so both reuse its caches.
const github = new ApiGitHub();
const app = createApiApp({ github });

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  // The Cron Trigger (#670): the queue's sweep and the enrolment intents' retention (#821), each on its own so one
  // failing does not hold the other. A failure is logged, never left as an unhandled rejection.
  scheduled: (controller, env, ctx) => {
    const logger = createLogger({ service: 'api', component: 'cron' });
    const now = new Date(controller.scheduledTime);
    ctx.waitUntil(runLoggedSweep(logger, 'queue sweep failed', () => sweepQueue(env, now, logger, github)));
    ctx.waitUntil(
      runLoggedSweep(logger, 'enrolment intent sweep failed', () => sweepEnrolmentIntents(env, now, logger)),
    );
  },
} satisfies ExportedHandler<ApiEnv>;
