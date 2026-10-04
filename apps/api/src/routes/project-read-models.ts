import { Hono } from 'hono';
import type { EmbedOriginsDto } from '@shared/contracts';
import type { WorkerContext, WorkerHonoEnv } from '@worker/core';
import type { ApiEnv } from '../env';
import type { ApiGitHub } from '../github';
import { findProject, projectNotFound, repoOf } from '../projects/lookup';
import { ProjectReads } from '../read-models/project-reads';

/**
 * `/api/v1/projects/:slug/{inbox,questions,sprint,embed-origins}` (#35, #20). The slug is checked before anything else, so `/`, `..`
 * or `%2F` in it is a 404 `project-not-found` before D1 or GitHub is asked (#9 row 2); the repository comes only
 * from the registry row. Read-only installation tokens; the subrequest budget is on `ProjectReads`.
 */
async function readsFor(c: WorkerContext<ApiEnv>, github: ApiGitHub): Promise<ProjectReads | Response> {
  const project = await findProject(c, c.req.param('slug') ?? '');
  if (project === null) {
    return projectNotFound(c);
  }
  const repo = repoOf(c, project);
  if (repo instanceof Response) {
    return repo;
  }
  return new ProjectReads(github, c.env, project, repo, github.now);
}

export function createProjectReadModelRoutes(github: ApiGitHub): Hono<WorkerHonoEnv<ApiEnv>> {
  return new Hono<WorkerHonoEnv<ApiEnv>>()
    .get('/:slug/inbox', async (c) => {
      const reads = await readsFor(c, github);
      return reads instanceof Response ? reads : c.json(await reads.inbox());
    })
    .get('/:slug/questions', async (c) => {
      const reads = await readsFor(c, github);
      return reads instanceof Response ? reads : c.json(await reads.questions());
    })
    .get('/:slug/sprint', async (c) => {
      const reads = await readsFor(c, github);
      return reads instanceof Response ? reads : c.json(await reads.sprint());
    })
    .get('/:slug/embed-origins', async (c) => {
      const reads = await readsFor(c, github);
      if (reads instanceof Response) {
        return reads;
      }
      const body: EmbedOriginsDto = { embedOrigins: await reads.embedOrigins() };
      return c.json(body);
    });
}
