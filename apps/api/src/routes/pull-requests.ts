import { Hono } from 'hono';
import type { PullRequestDto, PullRequestListDto, PullRequestSyncDto } from '@shared/contracts';
import { withoutInvisibles } from '@shared/plain-text';
import { problem, type WorkerContext, type WorkerHonoEnv } from '@worker/core';
import {
  PullRequestsRepo,
  type PullRequestRecord,
  type PullRequestRowState,
  type ProjectRow,
} from '@worker/db';
import { isPullRequestState } from '@worker/vcs';
import { policyActorOfContext, trackerAccess } from '../auth/tracker-access.middleware';
import type { ApiEnv } from '../env';
import type { ApiGitHub } from '../github';
import { findProject, projectNotFound, repoOf } from '../projects/lookup';
import type { OwnerConnectionSource } from '../projects/owner-connection';
import { syncPullRequest, syncPullRequests } from '../read-models/pull-request-sync';
import { repoIdOf } from '../read-models/repo-id';
import { invalid } from '../tracker/context';
import { pageOf } from '../tracker/http';

type Context = WorkerContext<ApiEnv>;

const NUMBER = /^[1-9][0-9]{0,9}$/;

function pullRequestDtoOf(row: PullRequestRecord): PullRequestDto {
  return {
    number: row.number,
    title: withoutInvisibles(row.title),
    state: row.state,
    draft: row.draft,
    headRef: row.headRef,
    headSha: row.headSha,
    baseRef: row.baseRef,
    author: row.authorLogin,
    url: row.url,
    ci: row.ciState,
    ciStale: row.ciStale,
    updatedAt: row.updatedAt,
    syncedAt: row.syncedAt,
  };
}

/** `?fresh=1` or nothing; anything else is a 400 rather than silently a cached read. */
function freshOf(c: Context): boolean | Response {
  const fresh = c.req.query('fresh');
  if (fresh === undefined) {
    return false;
  }
  return fresh === '1' ? true : invalid(c, 'query-invalid', 'fresh', 'fresh is 1 or absent');
}

/** `?state=open|closed|merged|all`, `open` by default. */
function stateOf(c: Context): PullRequestRowState | 'all' | Response {
  const state = c.req.query('state') ?? 'open';
  if (state === 'all' || isPullRequestState(state)) {
    return state;
  }
  return invalid(c, 'query-invalid', 'state', 'state is open, closed, merged or all');
}

async function projectOf(c: Context): Promise<ProjectRow | Response> {
  const project = await findProject(c, c.req.param('slug') ?? '');
  return project ?? projectNotFound(c);
}

/**
 * A provider read on demand is the account's to ask for (T-2, #466): a job of the project reads the rows D1 holds,
 * never spends the budget (403 `fresh-role`). The owner and the members may.
 */
function freshRefusal(c: Context): Response | null {
  if (policyActorOfContext(c).kind !== 'job') {
    return null;
  }
  return problem(c, {
    type: 'fresh-role',
    title: 'Forbidden',
    status: 403,
    detail: 'A job reads the pull requests the console holds; a fresh read is the account’s',
  });
}

/**
 * A project's pull requests (#463, ADR 0008 row 3a) from `pull_requests`, which the hooks Worker keeps current from
 * signed deliveries. `?fresh=1` first reads the provider through the VCS adapter (read-only installation token,
 * budgeted) and writes what it read — a GET that writes D1, like the request read of #270: only the provider's own
 * state, never a body's, and nothing an authorisation reads. Behind the route matrix like the tracker reads.
 */
export function createPullRequestRoutes(
  github: ApiGitHub,
  owners: OwnerConnectionSource,
  now: () => number = () => Date.now(),
): Hono<WorkerHonoEnv<ApiEnv>> {
  const guard = {
    list: trackerAccess('GET /api/v1/projects/:slug/prs'),
    read: trackerAccess('GET /api/v1/projects/:slug/prs/:number'),
  };
  return new Hono<WorkerHonoEnv<ApiEnv>>()
    .get('/:slug/prs', guard.list, async (c) => {
      const state = stateOf(c);
      const page = pageOf(c);
      const fresh = freshOf(c);
      if (state instanceof Response) {
        return state;
      }
      if (page instanceof Response) {
        return page;
      }
      if (fresh instanceof Response) {
        return fresh;
      }
      const project = await projectOf(c);
      if (project instanceof Response) {
        return project;
      }
      let sync: PullRequestSyncDto | null = null;
      if (fresh) {
        const refused = freshRefusal(c);
        if (refused !== null) {
          return refused;
        }
        const repo = repoOf(c, project);
        if (repo instanceof Response) {
          return repo;
        }
        const repoId = await repoIdOf(c, github, owners, project, repo);
        if (repoId instanceof Response) {
          return repoId;
        }
        sync = await syncPullRequests(github, c.env, project, repo, repoId, now);
      }
      const result = await new PullRequestsRepo(c.env.DB).list(
        project.slug,
        state === 'all' ? {} : { state },
        page.after,
        page.limit,
      );
      const body: PullRequestListDto = {
        pullRequests: result.items.map(pullRequestDtoOf),
        next: result.next,
        sync,
      };
      c.header('Cache-Control', 'no-store');
      return c.json(body);
    })

    .get('/:slug/prs/:number', guard.read, async (c) => {
      const raw = c.req.param('number') ?? '';
      const fresh = freshOf(c);
      if (!NUMBER.test(raw)) {
        return problem(c, {
          type: 'pull-request-number',
          title: 'Not a pull request number',
          status: 400,
          detail: 'A pull request is named by its number',
        });
      }
      if (fresh instanceof Response) {
        return fresh;
      }
      const project = await projectOf(c);
      if (project instanceof Response) {
        return project;
      }
      const number = Number(raw);
      const rows = new PullRequestsRepo(c.env.DB);
      let row = await rows.find(project.slug, number);
      if (fresh || row === null) {
        const refused = freshRefusal(c);
        if (refused !== null) {
          // A job gets the row the console holds, or its 404; the provider is not asked on its behalf.
          if (fresh) {
            return refused;
          }
        } else {
          const repo = repoOf(c, project);
          if (repo instanceof Response) {
            return repo;
          }
          const repoId = await repoIdOf(c, github, owners, project, repo);
          if (repoId instanceof Response) {
            return repoId;
          }
          if (await syncPullRequest(github, c.env, project, repo, repoId, number, now)) {
            row = await rows.find(project.slug, number);
          }
        }
      }
      if (row === null) {
        return problem(c, { type: 'pull-request-not-found', title: 'Pull request not found', status: 404 });
      }
      c.header('Cache-Control', 'no-store');
      return c.json(pullRequestDtoOf(row));
    });
}
