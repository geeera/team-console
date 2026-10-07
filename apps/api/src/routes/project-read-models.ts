import { Hono } from 'hono';
import type { EmbedOriginsDto, RequestIssuesDto, SprintDto } from '@shared/contracts';
import type { WorkerContext, WorkerHonoEnv } from '@worker/core';
import { OwnerRequestsRepo } from '@worker/db';
import type { ApiEnv } from '../env';
import type { ApiGitHub } from '../github';
import { findProject, projectNotFound, repoOf } from '../projects/lookup';
import { ProjectReads } from '../read-models/project-reads';
import { SubrequestBudget } from '../read-models/subrequest-budget';
import { requestStatusOf } from '../team/owner-requests';

/**
 * GitHub subrequests one sprint request may spend (#131). The Workers free plan allows 50 per request: this, plus the
 * registry query and the Access key set, leaves 4 for what the budget does not count (as on the overview). The lists
 * and the run log take at most 11 (token 2, milestones 1, sprint issues ≤ 3, pulls 1, run log ≤ 4: project.yml, the
 * issue, two pages of comments — #132), so at least 33 pull requests get their CI read on a cold isolate; past that
 * a row is `unknown`, and the next load reads on from the cache. A run log the budget stops is `unknown` too.
 */
export const SPRINT_GITHUB_BUDGET = 44;

/**
 * `/api/v1/projects/:slug/{inbox,questions,sprint,requests,embed-origins}` (#35, #20, #219). The slug is checked before anything else, so `/`, `..`
 * or `%2F` in it is a 404 `project-not-found` before D1 or GitHub is asked (#9 row 2); the repository comes only
 * from the registry row. Read-only installation tokens; the subrequest budget is on `ProjectReads`.
 */
async function readsFor(
  c: WorkerContext<ApiEnv>,
  github: ApiGitHub,
  budget?: SubrequestBudget,
): Promise<ProjectReads | Response> {
  const project = await findProject(c, c.req.param('slug') ?? '');
  if (project === null) {
    return projectNotFound(c);
  }
  const repo = repoOf(c, project);
  if (repo instanceof Response) {
    return repo;
  }
  const connection =
    budget === undefined ? undefined : await budget.connectionFor(await github.connect(c.env), repo);
  return new ProjectReads(github, c.env, project, repo, github.now, connection);
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
      const reads = await readsFor(c, github, new SubrequestBudget(SPRINT_GITHUB_BUDGET));
      if (reads instanceof Response) {
        return reads;
      }
      const sprint = await reads.sprint();
      // #219: the owner's requests from D1 in one query, no GitHub cost; display only.
      const requests = await new OwnerRequestsRepo(c.env.DB).latestPerIssue(c.req.param('slug'));
      const body: SprintDto = {
        ...sprint,
        issues: sprint.issues.map((issue) => {
          const record = requests.get(issue.number);
          return { ...issue, request: record === undefined ? null : requestStatusOf(record) };
        }),
      };
      return c.json(body);
    })
    .get('/:slug/requests', async (c) => {
      const reads = await readsFor(c, github);
      if (reads instanceof Response) {
        return reads;
      }
      const [issues, requests] = await Promise.all([
        reads.requestableIssues(),
        new OwnerRequestsRepo(c.env.DB).latestPerIssue(c.req.param('slug')),
      ]);
      const body: RequestIssuesDto = {
        items: issues.map((issue) => {
          const record = requests.get(issue.number);
          return { ...issue, request: record === undefined ? null : requestStatusOf(record) };
        }),
      };
      return c.json(body);
    })
    .get('/:slug/embed-origins', async (c) => {
      const reads = await readsFor(c, github);
      if (reads instanceof Response) {
        return reads;
      }
      // The SPA and the api share one origin per environment, so the request's origin is the console's own.
      const body: EmbedOriginsDto = { embedOrigins: await reads.embedOrigins(new URL(c.req.url).origin) };
      return c.json(body);
    });
}
