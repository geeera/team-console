import { Hono } from 'hono';
import { renderRunnerWorkflow } from '@shared/actions-workflow';
import type { ActionsWorkflowDto } from '@shared/contracts';
import { problem, type WorkerContext, type WorkerHonoEnv } from '@worker/core';
import { trackerAccess } from '../auth/tracker-access.middleware';
import type { ApiEnv } from '../env';

type Context = WorkerContext<ApiEnv>;

const P = '/api/v1/projects/:slug';

function originMisconfigured(c: Context, reason: string): Response {
  // The reason is a fixed enum; the configured and the request's origins stay out of the log and the answer.
  c.get('logger').error('runner workflow not rendered', { reason });
  return problem(c, {
    type: 'console-origin-misconfigured',
    title: 'The console cannot render its runner workflow',
    status: 503,
    detail: 'CONSOLE_PUBLIC_ORIGIN of this console is missing, malformed or not the origin it is served on',
  });
}

/**
 * The customer's Actions setup (#759; architect note §2 and §4). `GET …/actions-setup/workflow` answers this
 * console's rendering of the runner workflow: the bundled template with `CONSOLE_PUBLIC_ORIGIN` and
 * `runnerAudienceOf(ENVIRONMENT)` baked in. Nothing of the request reaches the text: the project only scopes who may
 * read it (the account), and the request's origin is only compared with the configured one, never copied.
 */
export function createActionsSetupRoutes(): Hono<WorkerHonoEnv<ApiEnv>> {
  return new Hono<WorkerHonoEnv<ApiEnv>>().get(
    '/:slug/actions-setup/workflow',
    trackerAccess(`GET ${P}/actions-setup/workflow`),
    async (c) => {
      const consoleOrigin = c.env.CONSOLE_PUBLIC_ORIGIN ?? '';
      const outcome = await renderRunnerWorkflow({ consoleOrigin, environment: c.env.ENVIRONMENT });
      if (!outcome.ok) {
        if (outcome.failure === 'template-invalid') {
          // The template spec guards this; reaching it means the bundled template broke an invariant.
          throw new Error(`the bundled runner workflow template is invalid: ${outcome.detail}`);
        }
        return originMisconfigured(c, outcome.failure);
      }
      if (new URL(c.req.url).origin !== consoleOrigin) {
        return originMisconfigured(c, 'console-origin-mismatch');
      }
      const { text, sha256, pins } = outcome.rendering;
      const body: ActionsWorkflowDto = { text, sha256, version: pins.runner };
      return c.json(body);
    },
  );
}
