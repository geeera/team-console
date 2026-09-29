import { Hono } from 'hono';
import type { ProjectDto, ProjectRepositoryDto } from '@shared/contracts';
import { problem, type WorkerContext, type WorkerHonoEnv } from '@worker/core';
import { ProjectsRepo, toProjectDto, type ProjectRow } from '@worker/db';
import {
  GitHubClient,
  InvalidRepoNameError,
  githubPath,
  parseRepoName,
  readCacheKey,
  type RepoName,
} from '@worker/github';
import type { ApiEnv } from '../env';
import type { ApiGitHub } from '../github';

// Threat row 2 of #9: a slug with `/`, `..` or an encoded slash never reaches D1 or GitHub.
const SLUG_PATTERN = /^[a-z0-9-]{1,40}$/;
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

async function findProject(c: WorkerContext<ApiEnv>, slug: string): Promise<ProjectRow | null> {
  return SLUG_PATTERN.test(slug) ? new ProjectsRepo(c.env.DB).findActiveBySlug(slug) : null;
}

function repoOf(c: WorkerContext<ApiEnv>, project: ProjectRow): RepoName | Response {
  try {
    return parseRepoName(project.repo);
  } catch (error: unknown) {
    if (!(error instanceof InvalidRepoNameError)) {
      throw error;
    }
    // Registry rows are validated on write (#15); one that is not is our data, so it never reaches a URL.
    c.get('logger').error('registry row holds an invalid repository name', { slug: project.slug });
    return problem(c, {
      type: 'project-invalid',
      title: 'The project has an invalid repository name',
      status: 500,
    });
  }
}

/**
 * The project registry. The repo of every GitHub read comes from the registry row, never from the request, and
 * there is no route that passes a client-chosen path through to GitHub (#9 threat row 2).
 */
export function createProjectsRoutes(github: ApiGitHub): Hono<WorkerHonoEnv<ApiEnv>> {
  return new Hono<WorkerHonoEnv<ApiEnv>>()
    .get('/', async (c) => {
      const rows = await new ProjectsRepo(c.env.DB).listActive();
      const body: ProjectDto[] = rows.map(toProjectDto);
      return c.json(body);
    })
    .get('/:slug/repository', async (c) => {
      const project = await findProject(c, c.req.param('slug'));
      if (project === null) {
        return problem(c, { type: 'project-not-found', title: 'Project not found', status: 404 });
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
