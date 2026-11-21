import { Hono } from 'hono';
import { renderRunnerWorkflow } from '@shared/actions-workflow';
import { isActionsSetupDto, isActionsWorkflowPrDto, type ActionsWorkflowDto } from '@shared/contracts';
import { problem, type WorkerHonoEnv } from '@worker/core';
import { checkActionsReadiness, readinessTargetOf } from '../actions/readiness';
import { isSetupWriteAllowed, openWorkflowPr } from '../actions/workflow-pr';
import { trackerAccess, trackerProjectOfContext } from '../auth/tracker-access.middleware';
import type { ApiEnv } from '../env';
import type { ApiGitHub } from '../github';
import { SMALL_WRITE_MAX_BYTES, writeLimit } from '../tracker/http';
import {
  originMisconfigured,
  readinessRateRefusal,
  uncheckedReadiness,
  workflowPrRateRefusal,
  workflowPrRefusal,
} from './actions-setup-problems';
import { jobAuditOf } from './jobs';

const P = '/api/v1/projects/:slug';

/**
 * The customer's Actions setup (#759; architect note §2 and §4). `GET …/actions-setup/workflow` answers this
 * console's rendering of the runner workflow: the bundled template with `CONSOLE_PUBLIC_ORIGIN` and
 * `runnerAudienceOf(ENVIRONMENT)` baked in. Nothing of the request reaches the text: the project only scopes who may
 * read it (the account), and the request's origin is only compared with the configured one, never copied.
 *
 * `GET …/actions-setup` (PR 3) is the readiness check, item by item (`actions/readiness.ts`). It is the account
 * owner's only (security note row "Cross-tenant or member trigger"): every call mints a token, so a member gets 403
 * and another account 404 from `trackerAccess` before anything is counted or asked of GitHub. Rate limited per
 * project. The answer is never stored or cached: it is re-read on every call. Only the workflow item's status, the
 * rendering's sha256 and the time are kept, for Needs you (#874).
 *
 * `POST …/actions-setup/workflow-pr` (PR 4) opens the pull request with that rendering in the project's repository
 * (`actions/workflow-pr.ts`). The account owner's only, like the check; it takes no body and reads none, so nothing of
 * the request can steer what is written. Behind the kill switch (503 `github-write-disabled` with the var off or an
 * operator stop, before anything is counted or asked of GitHub), then rate limited per project and per account.
 */
export function createActionsSetupRoutes(github: ApiGitHub): Hono<WorkerHonoEnv<ApiEnv>> {
  return new Hono<WorkerHonoEnv<ApiEnv>>()
    .get('/:slug/actions-setup', trackerAccess(`GET ${P}/actions-setup`), async (c) => {
      const row = trackerProjectOfContext(c);
      const target = await readinessTargetOf({ env: c.env }, row);
      if (target === null) {
        return problem(c, { type: 'project-not-found', title: 'Project not found', status: 404 });
      }
      const limited = await readinessRateRefusal(c, row.slug, github.now());
      if (limited !== null) {
        return limited;
      }
      const outcome = await checkActionsReadiness(
        { env: c.env, github, logger: c.get('logger'), requestOrigin: new URL(c.req.url).origin },
        row,
        target,
      );
      if (outcome.kind !== 'checked') {
        return uncheckedReadiness(c, outcome);
      }
      // The key-set guard is the answer's last gate: a field added by mistake fails loudly instead of leaking.
      if (!isActionsSetupDto(outcome.setup)) {
        throw new Error('the readiness check built an answer outside its contract');
      }
      c.header('Cache-Control', 'no-store');
      return c.json(outcome.setup);
    })
    .post(
      '/:slug/actions-setup/workflow-pr',
      trackerAccess(`POST ${P}/actions-setup/workflow-pr`),
      writeLimit(SMALL_WRITE_MAX_BYTES),
      async (c) => {
        const row = trackerProjectOfContext(c);
        const target = await readinessTargetOf({ env: c.env }, row);
        if (target === null) {
          return problem(c, { type: 'project-not-found', title: 'Project not found', status: 404 });
        }
        // Judged here too, so a switched-off path costs no rate-limit hit; `openWorkflowPr` judges it again itself.
        if (!(await isSetupWriteAllowed(c.env))) {
          return workflowPrRefusal(c, { kind: 'write-disabled' });
        }
        const limited = await workflowPrRateRefusal(c, { slug: row.slug, accountId: row.account_id }, github.now());
        if (limited !== null) {
          return limited;
        }
        const outcome = await openWorkflowPr(
          {
            env: c.env,
            github,
            logger: c.get('logger'),
            requestOrigin: new URL(c.req.url).origin,
            audit: (kind, details) => jobAuditOf(c, row.account_id, new Date().toISOString(), kind, row.slug, details),
          },
          row,
          target,
        );
        if (outcome.kind !== 'opened') {
          return workflowPrRefusal(c, outcome);
        }
        if (!isActionsWorkflowPrDto(outcome.pr)) {
          throw new Error('the workflow pull request answer is outside its contract');
        }
        c.header('Cache-Control', 'no-store');
        return c.json(outcome.pr, 201);
      },
    )
    .get(
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
