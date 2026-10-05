import { Hono } from 'hono';
import type { ProjectRepositoryDto } from '@shared/contracts';
import type { WorkerHonoEnv } from '@worker/core';
import { GitHubClient, githubPath, readCacheKey } from '@worker/github';
import type { ApiEnv } from '../env';
import type { ApiGitHub } from '../github';
import { findProject, projectNotFound, repoOf } from '../projects/lookup';

const READ_TTL_SECONDS = 60;

interface GitHubRepository {
  readonly full_name: string;
  readonly private: boolean;
  readonly default_branch: string;
}

function isGitHubRepository(value: unknown): value is GitHubRepository {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record['full_name'] === 'string' &&
    typeof record['private'] === 'boolean' &&
    typeof record['default_branch'] === 'string'
  );
}

/**
 * Per-project GitHub reads. The repo of every GitHub read comes from the registry row, never from the request,
 * and there is no route that passes a client-chosen path through to GitHub (#9 threat row 2). The registry
 * itself (list, add, update, archive, setup) is `project-registry.ts`.
 */
export function createProjectsRoutes(github: ApiGitHub): Hono<WorkerHonoEnv<ApiEnv>> {
  return new Hono<WorkerHonoEnv<ApiEnv>>().get('/:slug/repository', async (c) => {
    const project = await findProject(c, c.req.param('slug'));
    if (project === null) {
      return projectNotFound(c);
    }
    const repo = repoOf(c, project);
    if (repo instanceof Response) {
      return repo;
    }
    const key = readCacheKey({
      environment: c.env.ENVIRONMENT,
      slug: project.slug,
      epoch: project.cache_epoch,
      type: 'repository',
    });
    // Subrequests: 3 on a cold isolate (installation, mint, read), 1 with a cached token, 0 within the TTL.
    const body = await github.readCache.getOrFill(
      key,
      READ_TTL_SECONDS,
      async (): Promise<ProjectRepositoryDto> => {
        const { auth, fetch } = await github.connect(c.env);
        const client = new GitHubClient(fetch, auth.tokenSourceFor(repo));
        const read = await client.getJson(githubPath`/repos/${repo}`, isGitHubRepository);
        return { repo: read.full_name, private: read.private, defaultBranch: read.default_branch };
      },
    );
    return c.json(body);
  });
}
