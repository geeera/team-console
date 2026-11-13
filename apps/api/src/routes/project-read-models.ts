import { Hono } from 'hono';
import type { EmbedOriginsDto, RequestIssuesDto, SprintDto, SprintFreezeDaysDto } from '@shared/contracts';
import { problem, type WorkerContext, type WorkerHonoEnv } from '@worker/core';
import { OwnerRequestsRepo, RateLimitsRepo, TrackerProjectsRepo, rateWindowOf, retryAfterOf } from '@worker/db';
import type { ApiEnv } from '../env';
import type { ApiGitHub } from '../github';
import { findProject, projectNotFound, repoOf, trackerProjectOf } from '../projects/lookup';
import { ProjectReads, freezeDaysOfFile } from '../read-models/project-reads';
import { SubrequestBudget } from '../read-models/subrequest-budget';
import { TrackerReads, readsRows } from '../read-models/tracker-reads';
import { requestStatusOf } from '../team/owner-requests';
import { guardedProjectRequests } from './tracker/requests';

/**
 * GitHub subrequests one sprint request may spend (#131). The Workers free plan allows 50 per request: this, plus the
 * registry query and the Access key set, leaves 4 for what the budget does not count (as on the overview). The lists
 * and the run log take at most 11 (token 2, milestones 1, sprint issues ≤ 3, pulls 1, run log ≤ 4: project.yml, the
 * issue, two pages of comments — #132), so at least 33 pull requests get their CI read on a cold isolate; past that
 * a row is `unknown`, and the next load reads on from the cache. A run log the budget stops is `unknown` too.
 */
export const SPRINT_GITHUB_BUDGET = 44;

/**
 * A job's `/sprint` reads per fixed window (#537): the runner's 120 calls a minute × `SPRINT_GITHUB_BUDGET` would be
 * ≈ 5k GitHub calls a minute, the installation's whole hourly quota, and the read cache is best-effort. 10 reads per
 * 10 minutes is at most 440 subrequests, ≈ 2.6k an hour per job, under the 5k quota with a cold cache; a job reads the
 * board once or twice a run. A minute window at any usable limit would not bound the hourly total.
 */
export const JOB_SPRINT_READS_PER_WINDOW = 10;
export const JOB_SPRINT_WINDOW_SECONDS = 600;

/**
 * The 429 when a job has spent its `/sprint` budget, else `null`; any other identity is not counted. Checked before
 * the project lookup on purpose: a flood costs one D1 upsert, no registry read and no token mint, and a job already
 * knows its own project, so answering 429 before a 404 leaks nothing.
 */
async function jobSprintRefusal(c: WorkerContext<ApiEnv>, github: ApiGitHub): Promise<Response | null> {
  const identity = c.get('identity');
  if (identity.kind !== 'job') {
    return null;
  }
  const at = github.now();
  const limit = await new RateLimitsRepo(c.env.DB).hit(
    `job:${identity.jobId}:sprint`,
    rateWindowOf(at, JOB_SPRINT_WINDOW_SECONDS),
    JOB_SPRINT_READS_PER_WINDOW,
  );
  if (limit.allowed) {
    return null;
  }
  c.get('logger').warn('job sprint budget exhausted', { jobId: identity.jobId });
  return problem(c, {
    type: 'rate-limited',
    title: 'Too Many Requests',
    status: 429,
    retryAfter: retryAfterOf(at, JOB_SPRINT_WINDOW_SECONDS),
  });
}

/**
 * `/api/v1/projects/:slug/{inbox,questions,sprint,requests,embed-origins,sprint-freeze}` (#35, #20, #219, #457; inbox
 * and questions of a console-tracker project from D1, #434). The slug is checked before anything else, so `/`, `..`
 * or `%2F` in it is a 404 `project-not-found` before D1 or GitHub is asked (#9 row 2); the repository comes only
 * from the registry row. Read-only installation tokens; the subrequest budget is on `ProjectReads`.
 *
 * A job of the project reads inbox, questions and sprint (#445, `JOB_READ_MODEL_ROUTES`): `findProject` applies its
 * scope, so another project is the same 404. Every other route here refuses it before it runs (`jobScopeMiddleware`).
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

/**
 * The inbox reads of the project: from D1 rows once its tracker left GitHub (`cutover` | `console`, #434), else the
 * GitHub reads. Same slug check and the same 404 either way; a row-backed project costs no GitHub subrequest.
 */
async function inboxReadsFor(
  c: WorkerContext<ApiEnv>,
  github: ApiGitHub,
): Promise<TrackerReads | ProjectReads | Response> {
  const reads = await readsFor(c, github);
  if (reads instanceof Response) {
    return reads;
  }
  const tracker = trackerProjectOf(reads.project);
  return readsRows(tracker) ? TrackerReads.of(c.env.DB, tracker, c.get('logger')) : reads;
}

export function createProjectReadModelRoutes(github: ApiGitHub): Hono<WorkerHonoEnv<ApiEnv>> {
  return new Hono<WorkerHonoEnv<ApiEnv>>()
    .get('/:slug/inbox', async (c) => {
      const reads = await inboxReadsFor(c, github);
      return reads instanceof Response ? reads : c.json(await reads.inbox());
    })
    .get('/:slug/questions', async (c) => {
      const reads = await inboxReadsFor(c, github);
      return reads instanceof Response ? reads : c.json(await reads.questions());
    })
    .get('/:slug/sprint', async (c) => {
      const refusal = await jobSprintRefusal(c, github);
      if (refusal !== null) {
        return refusal;
      }
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
      // #445: with `?state=` the path is the tracker's project-wide list, behind its route-matrix row.
      if (c.req.query('state') !== undefined) {
        return guardedProjectRequests(c);
      }
      // `jobScopeMiddleware` admits a job on this path for the `?state=` form only (#529); reaching here is a bug.
      if (c.get('identity').kind === 'job') {
        throw new Error('a job reached the owner’s requests list past the job scope');
      }
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
    })
    .get('/:slug/sprint-freeze', async (c) => {
      const reads = await readsFor(c, github);
      if (reads instanceof Response) {
        return reads;
      }
      // project.yml stays in the repository (ADR 0006 decision 9): the console tracker's freeze hints read it here,
      // through the shared cached read, so the tracker routes themselves stay D1 only.
      const body: SprintFreezeDaysDto = { freezeDays: freezeDaysOfFile(await reads.projectYmlFile()) };
      return c.json(body);
    });
}
