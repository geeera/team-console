import { Hono } from 'hono';
import {
  JOB_MAX_MINUTES_DEFAULT,
  checkRequestReviewsInput,
  type PullRequestDto,
  type PullRequestItemsDto,
  type PullRequestListDto,
  type PullRequestSyncDto,
  type ReviewJobRole,
  type ReviewRequestDto,
} from '@shared/contracts';
import { withoutInvisibles } from '@shared/plain-text';
import { newUlid, problem, type WorkerContext, type WorkerHonoEnv } from '@worker/core';
import {
  ItemsRepo,
  JobsRepo,
  PullRequestsRepo,
  type JobRecord,
  type NewAuditEvent,
  type NewJob,
  type PullRequestRecord,
  type PullRequestRowState,
  type ProjectRow,
} from '@worker/db';
import { isPullRequestState } from '@worker/vcs';
import { withJobTokenHold } from '../auth/job-auth';
import type { PolicyActor } from '../auth/policy';
import {
  policyActorOfContext,
  trackerAccess,
  trackerProjectOfContext,
} from '../auth/tracker-access.middleware';
import type { ApiEnv } from '../env';
import type { ApiGitHub } from '../github';
import { jsonBody } from '../json-body';
import { findProject, projectNotFound, repoOf, trackerProjectOf } from '../projects/lookup';
import type { OwnerConnectionSource } from '../projects/owner-connection';
import { syncPullRequest, syncPullRequests } from '../read-models/pull-request-sync';
import { repoIdOf } from '../read-models/repo-id';
import { bodySecretRefusal } from '../tracker/body-secret';
import { invalid, keyPrefixOf, trackerWriteRefusal } from '../tracker/context';
import { itemSummaryDtoOf } from '../tracker/dto';
import { SMALL_WRITE_MAX_BYTES, pageOf, writeLimit } from '../tracker/http';
import { dispatchActionsJobs } from '../actions/dispatch';
import { actionsOnSubscription } from './dispatch-problems';
import { jobAuditOf, jobDtoOf } from './jobs';

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

/** The `:number` of the path, or the 400 that says it is not one. */
function pullRequestNumberOf(c: Context): number | Response {
  const raw = c.req.param('number') ?? '';
  if (!NUMBER.test(raw)) {
    return problem(c, {
      type: 'pull-request-number',
      title: 'Not a pull request number',
      status: 400,
      detail: 'A pull request is named by its number',
    });
  }
  return Number(raw);
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
    reviews: trackerAccess('POST /api/v1/projects/:slug/prs/:number/reviews'),
    items: trackerAccess('GET /api/v1/projects/:slug/prs/:number/items'),
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
      const number = pullRequestNumberOf(c);
      const fresh = freshOf(c);
      if (number instanceof Response) {
        return number;
      }
      if (fresh instanceof Response) {
        return fresh;
      }
      const project = await projectOf(c);
      if (project instanceof Response) {
        return project;
      }
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
    })

    .get('/:slug/prs/:number/items', guard.items, async (c) => linkedItems(c))

    .post('/:slug/prs/:number/reviews', guard.reviews, writeLimit(SMALL_WRITE_MAX_BYTES), async (c) =>
      requestReviews(c, github),
    );
}

/**
 * `GET /api/v1/projects/:slug/prs/:number/items` (#627): the items linked to the pull request by `pr-linked` events
 * (`POST …/items/:key/pr-links`), with their labels, so the merge gate reads the console's links instead of the PR's
 * text. Answers from D1 alone: a pull request the mirror lacks, or one linked to nothing, is an empty page, never a
 * 404, so "no linked item" is one answer. `repo` lets the gate check the pull request belongs to the project (#628).
 */
async function linkedItems(c: Context): Promise<Response> {
  const number = pullRequestNumberOf(c);
  if (number instanceof Response) {
    return number;
  }
  const page = pageOf(c);
  if (page instanceof Response) {
    return page;
  }
  const row = trackerProjectOfContext(c);
  const result = await new ItemsRepo(c.env.DB).list(
    row.slug,
    { state: 'all', pullRequest: number },
    page.after,
    page.limit,
  );
  const keyPrefix = keyPrefixOf(trackerProjectOf(row));
  const body: PullRequestItemsDto = {
    number,
    provider: row.provider,
    repo: row.repo,
    items: result.items.map((item) => itemSummaryDtoOf(keyPrefix, item)),
    next: result.next,
  };
  c.header('Cache-Control', 'no-store');
  return c.json(body);
}

/** One live review job per pull request, head and role (the 0022 overlap guard); a repeat answers the live one. */
function reviewDedupeKeyOf(slug: string, number: number, headSha: string, role: ReviewJobRole): string {
  return `${slug}:review:${String(number)}:${headSha}:${role}`;
}

const LIVE_PARENT_STATES: ReadonlySet<JobRecord['state']> = new Set(['claimed', 'running']);

/**
 * The lineage rule of #612 (ADR 0006 R2): a review job's parent is the job that asked for it, read from the
 * requester's identity. It must be a claimed or running orchestrator job of this project, so a stand-in naming no
 * job, or a token outliving its job, enqueues nothing.
 */
async function parentJobOf(
  c: Context,
  actor: Extract<PolicyActor, { kind: 'job' }>,
  slug: string,
): Promise<JobRecord | Response> {
  const parent = await new JobsRepo(c.env.DB).findInProject(slug, actor.jobId);
  if (parent !== null && parent.role === 'orchestrator' && LIVE_PARENT_STATES.has(parent.state)) {
    return parent;
  }
  c.get('logger').warn('review request refused', { type: 'review-lineage', reason: 'parent-not-live' });
  return problem(c, {
    type: 'review-lineage',
    title: 'Forbidden',
    status: 403,
    detail: 'Reviews are requested by a claimed or running orchestrator job of the project',
    extensions: { reason: 'parent-not-live' },
  });
}

/**
 * `POST /api/v1/projects/:slug/prs/:number/reviews` (#612, `pr request-reviews` of `slot-qa`): one `review` job per
 * requested role, bound to the pull request's head as the console holds it (`head_sha` is never the request's), its
 * parent the requesting orchestrator job. The orchestrator job only (the route matrix). `note` is stored in the job
 * payload unchanged, as data; a secret in it is 422 `body-secret`. A repeat while the jobs are live answers them
 * (200); a request that adds a role enqueues only the new one (201).
 */
async function requestReviews(c: Context, github: ApiGitHub): Promise<Response> {
  const actor = policyActorOfContext(c);
  if (actor.kind !== 'job') {
    // The matrix row admits the orchestrator job only; anything else reaching here is a bug, never an open door.
    throw new Error('a review request reached the handler without a job actor');
  }
  const number = pullRequestNumberOf(c);
  if (number instanceof Response) {
    return number;
  }
  const row = trackerProjectOfContext(c);
  const notCutOver = trackerWriteRefusal(c, trackerProjectOf(row));
  if (notCutOver !== null) {
    return notCutOver;
  }
  const input = checkRequestReviewsInput(await jsonBody(c));
  if (!input.ok) {
    return invalid(c, 'review-request-invalid', input.field, input.detail);
  }
  const { roles, note } = input.value;
  const secret = bodySecretRefusal(c, actor, { note });
  if (secret !== null) {
    return secret;
  }
  const parent = await parentJobOf(c, actor, row.slug);
  if (parent instanceof Response) {
    return parent;
  }
  const pull = await new PullRequestsRepo(c.env.DB).find(row.slug, number);
  if (pull === null) {
    return problem(c, { type: 'pull-request-not-found', title: 'Pull request not found', status: 404 });
  }
  if (pull.state !== 'open') {
    return problem(c, {
      type: 'pull-request-not-open',
      title: 'The pull request is not open',
      status: 409,
      detail: 'Reviews are requested on an open pull request only',
    });
  }
  const keyOf = (role: ReviewJobRole): string => reviewDedupeKeyOf(row.slug, number, pull.headSha, role);
  const jobs = new JobsRepo(c.env.DB);
  const live = new Set((await jobs.findLiveByDedupeKeys(row.slug, roles.map(keyOf))).map((job) => job.dedupeKey));
  const now = new Date();
  const at = now.toISOString();
  const entries = roles
    .filter((role) => !live.has(keyOf(role)))
    .map((role): { readonly job: NewJob; readonly audit: NewAuditEvent } => {
      const id = newUlid(now.getTime());
      return {
        job: {
          id,
          accountId: row.account_id,
          projectSlug: row.slug,
          kind: 'review',
          role,
          payload: { pr: number, head_sha: pull.headSha, role, ...(note === null ? {} : { note }) },
          priority: 1,
          requestedBy: 'orchestrator',
          dedupeKey: keyOf(role),
          needsLocal: false,
          maxMinutes: JOB_MAX_MINUTES_DEFAULT,
          at,
          parentJobId: parent.id,
        },
        // Ids and enums only (CLAUDE.md): the note stays in the job's payload.
        audit: jobAuditOf(c, row.account_id, at, 'job.dispatched', id, {
          kind: 'review',
          role,
          pr: number,
          parent: parent.id,
          slug: row.slug,
        }),
      };
    });
  // The parent job is judged again inside the batch (#580): a narrowing, revoke or cancel since authentication wins.
  const enqueued = await withJobTokenHold(c, now, (hold) => jobs.enqueueAll(entries, hold));
  if (enqueued instanceof Response) {
    return enqueued;
  }
  if (enqueued === 'job-exists') {
    // A concurrent request for the same head and role won between the read and the write; a retry answers its job.
    return problem(c, {
      type: 'job-exists',
      title: 'Conflict',
      status: 409,
      detail: 'A review of this head by one of these roles was requested at the same time; retry to read it',
    });
  }
  if (enqueued === 'access-source-hosted') {
    return actionsOnSubscription(c);
  }
  // #670: the review jobs this request created are dispatched now when the project runs on GitHub Actions.
  const created = new Set(entries.map((entry) => entry.job.id));
  await dispatchActionsJobs(
    { env: c.env, github, logger: c.get('logger') },
    (await jobs.findLiveByDedupeKeys(row.slug, roles.map(keyOf))).filter((job) => created.has(job.id)),
  );
  const byKey = new Map(
    (await jobs.findLiveByDedupeKeys(row.slug, roles.map(keyOf))).map((job) => [job.dedupeKey, job] as const),
  );
  // A created job whose dispatch failed is no longer live; the caller still sees it, `failed`.
  for (const id of created) {
    const job = await jobs.findById(id);
    if (job !== null && !byKey.has(job.dedupeKey)) {
      byKey.set(job.dedupeKey, job);
    }
  }
  const body: ReviewRequestDto = {
    number,
    headSha: pull.headSha,
    jobs: roles.flatMap((role) => {
      const job = byKey.get(keyOf(role));
      return job === undefined ? [] : [jobDtoOf(job)];
    }),
  };
  c.get('logger').info('review jobs requested', {
    slug: row.slug,
    pr: number,
    roles: roles.join(','),
    created: entries.length,
  });
  c.header('Cache-Control', 'no-store');
  return c.json(body, entries.length > 0 ? 201 : 200);
}
