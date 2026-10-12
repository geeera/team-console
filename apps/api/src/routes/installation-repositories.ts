import { Hono } from 'hono';
import type {
  InstallationRepositoriesDto,
  InstallationRepositoryDto,
  RepositoryRegistration,
} from '@shared/contracts';
import type { WorkerHonoEnv } from '@worker/core';
import { ProjectsRepo, type ProjectRow } from '@worker/db';
import {
  GitHubClient,
  GitHubError,
  ownerNotConnectedError,
  readCacheKey,
  type InstallationRepository,
} from '@worker/github';
import type { ApiEnv } from '../env';
import type { ApiGitHub, GitHubConnection } from '../github';
import type { OwnerConnectionSource } from '../projects/owner-connection';
import { installUrlFor, isGitHubProblem } from '../projects/repository-checks';
import { SubrequestBudget } from '../read-models/subrequest-budget';

/**
 * #194 architect note §4: pages of 100, at most 10 (1,000 repositories), under a budget of 20 GitHub subrequests —
 * the lookup and a cold mint (2) plus 10 pages, with room for the uncounted `GET /app` of a 404 and one re-mint
 * after a 401, far under the Worker's 50 with D1 on top.
 */
export const INSTALLATION_LIST_MAX_PAGES = 10;
export const INSTALLATION_LIST_BUDGET = 20;
const INSTALLATION_LIST_TTL_S = 60;

/** GitHub's part of the answer, the one that is cached; the registry is merged per request. */
export interface InstallationList {
  readonly installationId: number;
  readonly repositories: readonly InstallationRepository[];
  readonly partial: boolean;
}

export interface InstallationListLimits {
  readonly budget: number;
  readonly maxPages: number;
}

const DEFAULT_LIMITS: InstallationListLimits = {
  budget: INSTALLATION_LIST_BUDGET,
  maxPages: INSTALLATION_LIST_MAX_PAGES,
};

/**
 * Reads the list of the installation on account `userId` (its pinned id, never its login). The page cap, or the
 * request budget once at least one page is in, ends the read with `partial: true` and what was read; a budget spent
 * before the first page is 503 `github-request-budget` like everywhere else.
 */
export async function readInstallationList(
  github: GitHubConnection,
  userId: number,
  limits: InstallationListLimits = DEFAULT_LIMITS,
): Promise<InstallationList> {
  const budget = new SubrequestBudget(limits.budget);
  const list = await budget.listConnectionFor(github, userId);
  const read: InstallationRepository[] = [];
  try {
    const result = await GitHubClient.listInstallationRepositories(list.fetch, list.source, {
      maxPages: limits.maxPages,
      onPage: (page) => read.push(...page),
    });
    return { installationId: list.installationId, repositories: result.items, partial: !result.complete };
  } catch (error: unknown) {
    if (isGitHubProblem(error, 'github-request-budget') && read.length > 0) {
      return { installationId: list.installationId, repositories: read, partial: true };
    }
    throw error;
  }
}

/** Where the owner changes which repositories the installation sees: the user-account page (org ones are out). */
export function selectionUrlFor(installationId: number): string {
  return `https://github.com/settings/installations/${installationId}`;
}

/** An active row wins over an archived one for the same repository; the match ignores case, as GitHub does. */
function registryByRepo(rows: readonly ProjectRow[]): Map<string, ProjectRow> {
  const byRepo = new Map<string, ProjectRow>();
  for (const row of rows) {
    const key = row.repo.toLowerCase();
    const known = byRepo.get(key);
    if (known === undefined || (known.archived_at !== null && row.archived_at === null)) {
      byRepo.set(key, row);
    }
  }
  return byRepo;
}

function registrationOf(row: ProjectRow | undefined): RepositoryRegistration {
  if (row === undefined) {
    return { state: 'none' };
  }
  return row.archived_at === null
    ? { state: 'active', slug: row.slug }
    : { state: 'archived', slug: row.slug };
}

export function installationRepositoriesOf(
  list: InstallationList,
  rows: readonly ProjectRow[],
): InstallationRepositoriesDto {
  const byRepo = registryByRepo(rows);
  const repositories: InstallationRepositoryDto[] = list.repositories
    .map((repo) => ({
      fullName: repo.fullName,
      private: repo.private,
      registration: registrationOf(byRepo.get(repo.fullName.toLowerCase())),
    }))
    .sort((a, b) => {
      const left = a.fullName.toLowerCase();
      const right = b.fullName.toLowerCase();
      return left < right ? -1 : left > right ? 1 : 0;
    });
  return { repositories, partial: list.partial, selectionUrl: selectionUrlFor(list.installationId) };
}

/**
 * `GET /api/v1/github/installation/repositories[?fresh=1]` (#194). A read: open to the service identity on dev and
 * stage like every other read, so it is mounted before the owner-only connection routes. Order (ADR 0003 decision 6
 * as amended): no usable owner connection → 403 before any JWT is signed or GitHub is asked; then GitHub's part
 * through the 60 s read cache (`fresh=1` is the Refresh button), then the registry from D1, which needs no GitHub
 * call, so a project added a moment ago shows at once. `Cache-Control: no-store` comes from `createWorkerApp`.
 */
export function createInstallationRepositoriesRoutes(
  github: ApiGitHub,
  owners: OwnerConnectionSource,
): Hono<WorkerHonoEnv<ApiEnv>> {
  return new Hono<WorkerHonoEnv<ApiEnv>>().get('/installation/repositories', async (c) => {
    const owner = await owners.current(c.env, c.get('logger'));
    if (owner === null) {
      throw ownerNotConnectedError();
    }
    const connection = await github.connect(c.env);
    const key = readCacheKey({
      environment: c.env.ENVIRONMENT,
      // `settings` is a reserved slug: no project can own this key. There is no project epoch for it.
      slug: 'settings',
      epoch: 0,
      type: `installation-repositories-${owner.userId}`,
    });
    let list: InstallationList;
    try {
      list = await github.readCache.getOrFill(
        key,
        INSTALLATION_LIST_TTL_S,
        () => readInstallationList(connection, owner.userId),
        { fresh: c.req.query('fresh') === '1' },
      );
    } catch (error: unknown) {
      if (isGitHubProblem(error, 'github-app-not-installed')) {
        throw new GitHubError(
          {
            ...error.problem,
            extensions: { ...error.problem.extensions, installUrl: installUrlFor(c.env.ENVIRONMENT) },
          },
          error.githubStatus,
        );
      }
      throw error;
    }
    const rows = await new ProjectsRepo(c.env.DB).listAll();
    return c.json(installationRepositoriesOf(list, rows));
  });
}
