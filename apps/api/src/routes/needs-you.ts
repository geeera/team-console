import { Hono } from 'hono';
import { NEEDS_YOU_MAX_PROJECTS, type NeedsYouProjectRef } from '@shared/contracts';
import type { WorkerHonoEnv } from '@worker/core';
import { ProjectsRepo } from '@worker/db';
import { GitHubError, InvalidRepoNameError, parseRepoName } from '@worker/github';
import { buildNeedsYou, type ProjectInboxResult } from '@worker/read-models';
import type { ApiEnv } from '../env';
import type { ApiGitHub } from '../github';
import { projectProblemOf } from '../read-models/errors';
import { ProjectReads } from '../read-models/project-reads';

/**
 * `GET /api/v1/needs-you` (#35, #9 row 8): the inbox of every active project, merged.
 *
 * Subrequest budget (Workers free plan: 50 per request). The first NEEDS_YOU_MAX_PROJECTS (6) active projects are
 * read, each at most 6 subrequests on a cold isolate (installation lookup, token mint, ≤ 3 pages of open issues,
 * project.yml; see `ProjectReads`) → ≤ 36, plus 1 D1 query and the Access key set → ≤ 38. Later projects are
 * listed in `omittedProjects`, not read. Within the read cache's TTL a project costs nothing.
 *
 * A project that fails is reported on its own row and the others are still shown — except a GitHub rate limit,
 * which the whole answer surfaces as 429 with `Retry-After` (the longest wait any project got), because the next
 * read of any project would hit the same limit.
 */
export function createNeedsYouRoutes(github: ApiGitHub): Hono<WorkerHonoEnv<ApiEnv>> {
  return new Hono<WorkerHonoEnv<ApiEnv>>().get('/', async (c) => {
    const active = await new ProjectsRepo(c.env.DB).listActive();
    const read = active.slice(0, NEEDS_YOU_MAX_PROJECTS);
    const omitted: NeedsYouProjectRef[] = active
      .slice(NEEDS_YOU_MAX_PROJECTS)
      .map((row) => ({ slug: row.slug, name: row.display_name }));

    const settled = await Promise.allSettled(
      read.map(async (row) =>
        new ProjectReads(github, c.env, row, parseRepoName(row.repo), github.now).inbox(),
      ),
    );

    let rateLimit: GitHubError | undefined;
    const results: ProjectInboxResult[] = settled.map((outcome, index) => {
      const row = read[index];
      if (row === undefined) {
        throw new Error('settled results outnumber the projects read');
      }
      const project = { slug: row.slug, name: row.display_name };
      if (outcome.status === 'fulfilled') {
        return { project, inbox: outcome.value };
      }
      const error: unknown = outcome.reason;
      if (error instanceof GitHubError && error.problem.type === 'github-rate-limit') {
        if ((error.problem.retryAfter ?? 0) >= (rateLimit?.problem.retryAfter ?? -1)) {
          rateLimit = error;
        }
      }
      if (error instanceof InvalidRepoNameError) {
        c.get('logger').error('registry row holds an invalid repository name', { slug: row.slug });
        return {
          project,
          problem: {
            type: 'project-invalid',
            title: 'The project has an invalid repository name',
            status: 500,
          },
        };
      }
      const problem = projectProblemOf(error);
      if (problem === undefined) {
        // Not a known failure (a bug): the request fails as a whole rather than hiding it.
        throw error;
      }
      c.get('logger').warn('needs-you project failed', { slug: row.slug, problem: problem.type });
      return { project, problem };
    });
    if (rateLimit !== undefined) {
      throw rateLimit;
    }
    return c.json(buildNeedsYou(results, omitted));
  });
}
