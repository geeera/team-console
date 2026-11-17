import { Hono } from 'hono';
import { checkProjectDispatchInput, type ProjectDispatchDto } from '@shared/contracts';
import { problem, type ProblemExtensionValue, type WorkerContext, type WorkerHonoEnv } from '@worker/core';
import { ProjectDispatchRepo } from '@worker/db';
import { GitHubClient, readRegisteredRepository } from '@worker/github';
import { trackerAccess, trackerProjectOfContext } from '../auth/tracker-access.middleware';
import type { ApiEnv } from '../env';
import type { ApiGitHub } from '../github';
import { jsonBody } from '../json-body';
import { repoOf } from '../projects/lookup';
import { actionsOnSubscription, placementConflict } from './dispatch-problems';
import { SMALL_WRITE_MAX_BYTES, writeLimit } from '../tracker/http';
import { jobAuditOf } from './jobs';

type Context = WorkerContext<ApiEnv>;

const P = '/api/v1/projects/:slug';

function refused(c: Context, type: string, detail: string): Response {
  const extensions: Record<string, ProblemExtensionValue> = { field: 'dispatch' };
  return problem(c, { type, title: 'Invalid request', status: 422, detail, extensions });
}

/**
 * `GET|PUT /api/v1/projects/:slug/dispatch` (#670): how the project's jobs reach a runner — `pull` or `actions`.
 * The owner switches it; the account reads it. Switching to `actions` reads the repository from GitHub first and
 * takes `default_branch` from that answer (#695 item 4), after checking GitHub's `id` is the registered `repo_id`;
 * the write then refuses, inside its own UPDATE, a `subscription` project (#706) and a `pinned`/`failover` placement
 * (#695 item 2). Audited as `project.dispatch-changed`. Jobs keep the dispatch they were enqueued with.
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

    .put('/:slug/dispatch', trackerAccess(`PUT ${P}/dispatch`), writeLimit(SMALL_WRITE_MAX_BYTES), async (c) => {
      const row = trackerProjectOfContext(c);
      const input = checkProjectDispatchInput(await jsonBody(c));
      if (!input.ok) {
        const extensions: Record<string, ProblemExtensionValue> = { field: input.field };
        return problem(c, { type: 'dispatch-invalid', title: 'Invalid request', status: 422, detail: input.detail, extensions });
      }
      const { dispatch } = input.value;
      const repo = new ProjectDispatchRepo(c.env.DB);
      const before = await repo.find(row.slug);
      let defaultBranch: string | null = null;
      if (dispatch === 'actions') {
        if (row.repo_id === null) {
          return refused(c, 'dispatch-repository-unverified', 'The repository id of this project was never recorded');
        }
        const registered = repoOf(c, row);
        if (registered instanceof Response) {
          return registered;
        }
        const { auth, fetch } = await github.connect(c.env);
        const repository = await readRegisteredRepository(
          new GitHubClient(fetch, auth.tokenSourceFor(registered)),
          registered,
          row.repo_id,
        );
        if (repository === null) {
          c.get('logger').warn('dispatch refused', { reason: 'repository-id-mismatch', slug: row.slug });
          return refused(c, 'dispatch-repository-unverified', 'GitHub names another repository under this name');
        }
        defaultBranch = repository.defaultBranch;
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
        case 'placement-machine-bound':
          return placementConflict(c, 'dispatch');
        case 'repository-unverified':
          return refused(c, 'dispatch-repository-unverified', 'The repository id of this project was never recorded');
        case 'saved': {
          c.get('logger').info('project dispatch changed', { slug: row.slug, dispatch });
          const body: ProjectDispatchDto = { dispatch: outcome.record.dispatch, defaultBranch: outcome.record.defaultBranch };
          return c.json(body);
        }
      }
    });
}
