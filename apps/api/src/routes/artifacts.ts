import { Hono } from 'hono';
import type { WorkerHonoEnv } from '@worker/core';
import type { ApiEnv } from '../env';
import type { ApiGitHub } from '../github';
import { findProject, projectNotFound, repoOf } from '../projects/lookup';
import { ArtifactReads } from '../read-models/artifact-reads';
import { ProjectReads } from '../read-models/project-reads';

/**
 * `GET /api/v1/projects/:slug/artifacts[?fresh=1]` (#19): the project's decisions, designs and demos. The slug is
 * checked before D1 or GitHub is asked and the repository comes only from the registry row, as for the other read
 * models; `fresh=1` is the owner's "Check again" and skips the read cache for this answer.
 */
export function createArtifactRoutes(github: ApiGitHub): Hono<WorkerHonoEnv<ApiEnv>> {
  return new Hono<WorkerHonoEnv<ApiEnv>>().get('/:slug/artifacts', async (c) => {
    const project = await findProject(c, c.req.param('slug'));
    if (project === null) {
      return projectNotFound(c);
    }
    const repo = repoOf(c, project);
    if (repo instanceof Response) {
      return repo;
    }
    const reads = new ProjectReads(github, c.env, project, repo, github.now);
    const fresh = c.req.query('fresh') === '1';
    const artifacts = new ArtifactReads(
      github,
      c.env,
      project,
      repo,
      reads,
      c.get('logger'),
      fresh,
      github.now,
    );
    return c.json(await artifacts.all());
  });
}
