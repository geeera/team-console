import { Hono } from 'hono';
import type { OverviewDto, OverviewProjectDto } from '@shared/contracts';
import type { Logger, WorkerContext, WorkerHonoEnv } from '@worker/core';
import { ProjectsRepo, snoozeOf, type ProjectRow } from '@worker/db';
import { InvalidRepoNameError, parseRepoName } from '@worker/github';
import { buildOverviewRow } from '@worker/read-models';
import type { ApiEnv } from '../env';
import type { ApiGitHub } from '../github';
import { projectProblemOf } from '../read-models/errors';
import { ProjectReads } from '../read-models/project-reads';
import { SubrequestBudget } from '../read-models/subrequest-budget';

/**
 * GitHub subrequests one overview request may spend. The Workers free plan allows 50 per request: this, plus the
 * registry query and the Access key set, leaves 4 for what the budget does not count (a "not installed" lookup's
 * `GET /app`, a token renewed after a 401).
 */
export const OVERVIEW_GITHUB_BUDGET = 44;
/** Projects read at once, in registry order, so the budget finishes the first ones rather than starting all. */
export const OVERVIEW_CONCURRENCY = 2;

async function mapInOrder<T, R>(
  items: readonly T[],
  concurrency: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index] as T;
      results[index] = await map(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

/** The first failure among settled reads, after all of them have stopped spending the budget. */
function valuesOrThrow<A, B, C>(
  settled: [PromiseSettledResult<A>, PromiseSettledResult<B>, PromiseSettledResult<C>],
): [A, B, C] {
  const [a, b, c] = settled;
  if (a.status === 'rejected') {
    throw a.reason;
  }
  if (b.status === 'rejected') {
    throw b.reason;
  }
  if (c.status === 'rejected') {
    throw c.reason;
  }
  return [a.value, b.value, c.value];
}

interface RowContext {
  readonly c: WorkerContext<ApiEnv>;
  readonly github: ApiGitHub;
  readonly budget: SubrequestBudget;
  readonly logger: Logger;
}

async function overviewRowOf(context: RowContext, row: ProjectRow): Promise<OverviewProjectDto> {
  const { c, github, budget, logger } = context;
  const project = { slug: row.slug, name: row.display_name };
  try {
    const repo = parseRepoName(row.repo);
    const connection = await budget.connectionFor(await github.connect(c.env), repo);
    const reads = new ProjectReads(github, c.env, row, repo, github.now, connection);
    const [inbox, sprint, teamRun] = valuesOrThrow(
      await Promise.allSettled([reads.inbox(), reads.currentSprint(), reads.teamRun()]),
    );
    return buildOverviewRow({
      ...project,
      team: teamRun.state,
      inbox,
      sprint,
      snooze: snoozeOf(row, github.now()),
    });
  } catch (error: unknown) {
    if (error instanceof InvalidRepoNameError) {
      logger.error('registry row holds an invalid repository name', { slug: row.slug });
      return {
        kind: 'failed',
        ...project,
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
    logger.warn('overview project not read', { slug: row.slug, problem: problem.type });
    return { kind: 'failed', ...project, problem };
  }
}

/**
 * `GET /api/v1/overview` (#27): one row per active project — the team running, paused or failing, the current sprint
 * with its demo day and done / total, what waits for the owner, the security setup — in one request.
 *
 * Every project is read through the same cached reads as "Needs you", the board and the team status (60 s; the team
 * state 30 s, one entry with the board's run state), so a warm overview costs no subrequest. A cold project costs at
 * most: token 2, inbox ≤ 4, current sprint ≤ 4, run log ≤ 3 (the issue, two pages of comments; project.yml is the inbox's read) — 8 for a usual
 * project, whose lists fit one page. The request never passes
 * `OVERVIEW_GITHUB_BUDGET`: a project the budget cannot finish is answered as its own `github-request-budget` row,
 * and what was read is cached, so the next request goes on from there. Any other failure is also confined to its
 * row — a rate limit included, since cached projects can still be shown.
 */
export function createOverviewRoutes(github: ApiGitHub): Hono<WorkerHonoEnv<ApiEnv>> {
  return new Hono<WorkerHonoEnv<ApiEnv>>().get('/', async (c) => {
    const active = await new ProjectsRepo(c.env.DB).listActive();
    const context: RowContext = {
      c,
      github,
      budget: new SubrequestBudget(OVERVIEW_GITHUB_BUDGET),
      logger: c.get('logger'),
    };
    const projects = await mapInOrder(active, OVERVIEW_CONCURRENCY, (row) => overviewRowOf(context, row));
    const body: OverviewDto = { projects, checkedAt: new Date(github.now()).toISOString() };
    c.header('Cache-Control', 'no-store');
    return c.json(body);
  });
}
