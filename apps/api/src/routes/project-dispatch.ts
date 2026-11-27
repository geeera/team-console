import { Hono } from 'hono';
import { blockingItemsOf, checkProjectDispatchInput, type ProjectDispatchDto } from '@shared/contracts';
import { problem, type ProblemExtensionValue, type WorkerHonoEnv } from '@worker/core';
import { ProjectDispatchRepo } from '@worker/db';
import { checkActionsReadiness, readinessTargetOf } from '../actions/readiness';
import { trackerAccess, trackerProjectOfContext } from '../auth/tracker-access.middleware';
import type { ApiEnv } from '../env';
import type { ApiGitHub } from '../github';
import { jsonBody } from '../json-body';
import {
  actionsNotReady,
  readinessRateRefusal,
  repositoryUnverified,
  uncheckedReadiness,
} from './actions-setup-problems';
import { actionsOnSubscription } from './dispatch-problems';
import { SMALL_WRITE_MAX_BYTES, writeLimit } from '../tracker/http';
import { jobAuditOf } from './jobs';

const P = '/api/v1/projects/:slug';

/**
 * `GET|PUT /api/v1/projects/:slug/dispatch` (#670): how the project's jobs reach a runner — `pull` or `actions`.
 * The owner switches it; the account reads it. Switching to `actions` runs the readiness check of #759 inside the
 * request (`actions/readiness.ts`; no client "ready" flag exists) and refuses 422 `actions-not-ready` with the blocking
 * items; the check reads the repository by its registered `repo_id` and its `default_branch` is what the switch
 * records (#695 item 4). A `subscription` project is refused first, before any GitHub call (#706), and again inside
 * the UPDATE. Switching to `pull` is never gated and calls no GitHub. A `pinned`/`failover` placement
 * stays as it is (#728): it applies to the project's pull jobs, which on an Actions project are its `needs_local` jobs
 * alone. Audited as `project.dispatch-changed`. Jobs keep the dispatch they were enqueued with.
 */
export function createProjectDispatchRoutes(github: ApiGitHub): Hono<WorkerHonoEnv<ApiEnv>> {
  return new Hono<WorkerHonoEnv<ApiEnv>>()
    .get('/:slug/dispatch', trackerAccess(`GET ${P}/dispatch`), async (c) => {
      const row = trackerProjectOfContext(c);
      const record = await new ProjectDispatchRepo(c.env.DB).find(row.slug);
      if (record === null) {
        return problem(c, { type: 'project-not-found', title: 'Project not found', status: 404 });
      }
      const body: ProjectDispatchDto = { dispatch: record.dispatch, defaultBranch: record.defaultBranch };
      return c.json(body);
    })

    .put(
      '/:slug/dispatch',
      trackerAccess(`PUT ${P}/dispatch`),
      writeLimit(SMALL_WRITE_MAX_BYTES),
      async (c) => {
        const row = trackerProjectOfContext(c);
        const input = checkProjectDispatchInput(await jsonBody(c));
        if (!input.ok) {
          const extensions: Record<string, ProblemExtensionValue> = { field: input.field };
          return problem(c, {
            type: 'dispatch-invalid',
            title: 'Invalid request',
            status: 422,
            detail: input.detail,
            extensions,
          });
        }
        const { dispatch } = input.value;
        const repo = new ProjectDispatchRepo(c.env.DB);
        const before = await repo.find(row.slug);
        let defaultBranch: string | null = null;
        if (dispatch === 'actions') {
          if (row.repo_id === null) {
            return repositoryUnverified(c, 'The repository id of this project was never recorded');
          }
          const target = await readinessTargetOf({ env: c.env }, row);
          if (target === null) {
            return problem(c, { type: 'project-not-found', title: 'Project not found', status: 404 });
          }
          if (target.accessSource !== 'api_key') {
            return actionsOnSubscription(c);
          }
          const limited = await readinessRateRefusal(
            c,
            { slug: row.slug, accountId: row.account_id },
            github.now(),
          );
          if (limited !== null) {
            return limited;
          }
          const readiness = await checkActionsReadiness(
            { env: c.env, github, logger: c.get('logger'), requestOrigin: new URL(c.req.url).origin },
            row,
            target,
          );
          if (readiness.kind !== 'checked') {
            return uncheckedReadiness(c, readiness);
          }
          const blocking = blockingItemsOf(readiness.setup.items);
          if (blocking.length > 0 || readiness.defaultBranch === null) {
            c.get('logger').info('dispatch refused', {
              reason: 'actions-not-ready',
              slug: row.slug,
              items: blocking.join(','),
            });
            return actionsNotReady(c, blocking);
          }
          defaultBranch = readiness.defaultBranch;
        }
        const at = new Date().toISOString();
        const outcome = await repo.set({
          slug: row.slug,
          dispatch,
          defaultBranch,
          audit: jobAuditOf(c, row.account_id, at, 'project.dispatch-changed', row.slug, {
            from: before?.dispatch ?? null,
            to: dispatch,
          }),
        });
        switch (outcome.kind) {
          case 'access-source-hosted':
            return actionsOnSubscription(c);
          case 'repository-unverified':
            return repositoryUnverified(c, 'The repository id of this project was never recorded');
          case 'saved': {
            c.get('logger').info('project dispatch changed', { slug: row.slug, dispatch });
            const body: ProjectDispatchDto = {
              dispatch: outcome.record.dispatch,
              defaultBranch: outcome.record.defaultBranch,
            };
            return c.json(body);
          }
        }
      },
    );
}
