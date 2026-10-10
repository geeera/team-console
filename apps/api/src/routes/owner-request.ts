import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  ANSWER_TEXT_MAX_LENGTH,
  isInFreeze,
  isOwnerRequest,
  type IssueRequestDto,
  type OwnerRequest,
  type OwnerRequestBody,
  type OwnerRequestResponse,
} from '@shared/contracts';
import { requestComment, requestMarker } from '@shared/owner-grammar';
import {
  problem,
  type LogFields,
  type ProblemInit,
  type WorkerContext,
  type WorkerHonoEnv,
} from '@worker/core';
import { OwnerRequestsRepo, type OwnerRequestRecord } from '@worker/db';
import {
  GitHubError,
  githubPath,
  githubUnexpectedError,
  type GitHubClient,
  type RepoName,
} from '@worker/github';
import { handledRequestOf, sprintToday } from '@worker/read-models';
import { ownerOnlyMiddleware } from '../auth/owner-only.middleware';
import type { ApiEnv } from '../env';
import type { ApiGitHub } from '../github';
import { jsonBody } from '../json-body';
import { ownerWriter } from '../owner/owner-writer';
import { postOwnerAnswer, type OwnerAnswerOutcome } from '../owner/post-owner-answer';
import { findProject, projectNotFound, repoOf } from '../projects/lookup';
import { ownerLanguageOf } from '../projects/project-yml';
import { repositoryClient } from '../projects/repository-checks';
import { ProjectReads, freezeDaysOfFile, readAllMilestones } from '../read-models/project-reads';
import { requestStatusOf } from '../team/owner-requests';
import { freezeOfDue, sprintPlanOf, type SprintPlan } from '../team/sprint-plan';

type Context = WorkerContext<ApiEnv>;

// The request, the milestone title and up to ANSWER_TEXT_MAX_LENGTH words at 3 UTF-8 bytes each, with escapes.
const MAX_BODY_BYTES = 8 * 1024;
const ISSUE_NUMBER = /^[1-9][0-9]{0,9}$/;
const MAX_TITLE_LENGTH = 255;
const COMMENTS_PER_PAGE = 100;

const REQUEST_IN_PROGRESS: ProblemInit = {
  type: 'request-in-progress',
  title: 'The same request is being written',
  status: 409,
  retryAfter: 2,
};

interface LiveIssue {
  readonly title: string;
  readonly state: 'open' | 'closed';
  readonly milestone: string | null;
  readonly isPullRequest: boolean;
  /** How many comments the issue has: the handled re-read pages from the end (`rereadPagesOf`). */
  readonly comments: number;
}

interface GitHubComment {
  readonly id: number;
  readonly body: string;
  readonly authorLogin: string | null;
  readonly authorType: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function liveIssueOf(value: unknown): LiveIssue | null {
  if (!isRecord(value) || typeof value['title'] !== 'string') {
    return null;
  }
  const state = value['state'];
  if (state !== 'open' && state !== 'closed') {
    return null;
  }
  const milestone = value['milestone'];
  if (
    milestone !== null &&
    milestone !== undefined &&
    !(isRecord(milestone) && typeof milestone['title'] === 'string')
  ) {
    return null;
  }
  const comments = value['comments'];
  return {
    title: value['title'],
    state,
    milestone: isRecord(milestone) ? String(milestone['title']) : null,
    isPullRequest: value['pull_request'] !== undefined && value['pull_request'] !== null,
    comments: typeof comments === 'number' && Number.isSafeInteger(comments) && comments > 0 ? comments : 0,
  };
}

function isAnyRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}

function commentsOf(value: unknown): GitHubComment[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item: unknown) => {
    if (!isRecord(item) || !Number.isSafeInteger(item['id']) || typeof item['body'] !== 'string') {
      return [];
    }
    const user = isRecord(item['user']) ? item['user'] : {};
    return [
      {
        id: Number(item['id']),
        body: item['body'],
        authorLogin: stringOrNull(user['login']),
        authorType: stringOrNull(user['type']),
        createdAt: stringOrNull(item['created_at']),
        updatedAt: stringOrNull(item['updated_at']),
      },
    ];
  });
}

/** The live issue, uncached: a stale milestone would let a request through that the form never saw. */
async function readIssue(client: GitHubClient, repo: RepoName, number: number): Promise<LiveIssue | null> {
  return liveIssueOf(await client.getJson(githubPath`/repos/${repo}/issues/${number}`, isAnyRecord));
}

/** `OwnerRequestBody`, or why not. Nothing of the input is echoed back. */
export function parseOwnerRequest(body: unknown): OwnerRequestBody | string {
  if (!isRecord(body)) {
    return 'The body must be a JSON object with request and expectedMilestone';
  }
  if (Object.keys(body).some((key) => !['request', 'expectedMilestone', 'ownerSaid'].includes(key))) {
    return 'Only request, expectedMilestone and ownerSaid may be sent';
  }
  const { request, expectedMilestone, ownerSaid } = body;
  if (!isOwnerRequest(request)) {
    return 'request must be {kind: "sprint", target: current|next|backlog} or {kind: "priority", direction: up|down}';
  }
  if (
    expectedMilestone !== null &&
    (typeof expectedMilestone !== 'string' || expectedMilestone.length > MAX_TITLE_LENGTH)
  ) {
    return `expectedMilestone must be null or a title of at most ${MAX_TITLE_LENGTH} characters`;
  }
  if (
    ownerSaid !== undefined &&
    (typeof ownerSaid !== 'string' || ownerSaid.length > ANSWER_TEXT_MAX_LENGTH)
  ) {
    return `ownerSaid must be a string of at most ${ANSWER_TEXT_MAX_LENGTH} characters`;
  }
  return { request, expectedMilestone, ...(ownerSaid === undefined ? {} : { ownerSaid }) };
}

function invalid(c: Context, detail: string): Response {
  return problem(c, { type: 'validation', title: 'Invalid request', status: 422, detail });
}

/** Why the live sprints do not take this request, or `null`. */
function sprintRefusal(c: Context, request: OwnerRequest, plan: SprintPlan): Response | null {
  if (request.kind !== 'sprint') {
    return null;
  }
  if (request.target === 'next' && plan.next === null) {
    return problem(c, {
      type: 'sprint-next-missing',
      title: 'The next sprint does not exist yet',
      status: 422,
      detail: 'Start the next sprint first, or ask for another one',
    });
  }
  if (request.target === 'current' && plan.current === null) {
    return problem(c, { type: 'sprint-none', title: 'There is no current sprint', status: 409 });
  }
  return null;
}

/**
 * When GitHub says it created the request comment (#269): the handled check compares it with the marker's
 * `created_at`, so both must come from GitHub's clock — a Worker clock running ahead would otherwise refuse the PM's
 * real answer and the request would wait forever. A replay answers with the row the first write recorded. The
 * Worker's clock is the last resort, when GitHub's answer carried no timestamp.
 */
async function requestedAtOf(
  c: Context,
  outcome: Extract<OwnerAnswerOutcome, { kind: 'written' | 'replayed' }>,
  fields: LogFields,
): Promise<string> {
  if (outcome.kind === 'written' && outcome.createdAt !== null) {
    return outcome.createdAt;
  }
  if (outcome.kind === 'replayed') {
    try {
      const recorded = await new OwnerRequestsRepo(c.env.DB).findByComment(outcome.write.commentId);
      if (recorded !== null) {
        return recorded.requestedAt;
      }
    } catch (error: unknown) {
      // GitHub holds the comment already: a 500 here would invite a retry. The replay answers with the Worker clock.
      const message = 'owner request: the recorded request could not be read, the Worker clock stands in';
      c.get('logger').warn(message, { ...fields, error });
      return new Date(outcome.write.createdAt).toISOString();
    }
  }
  c.get('logger').warn(
    "owner request: GitHub's created_at is not at hand, the Worker clock stands in",
    fields,
  );
  return new Date(outcome.write.createdAt).toISOString();
}

/** The pages that together hold at least the newest `perPage` comments: the last, plus the one before a short last. */
export function rereadPagesOf(commentCount: number, perPage: number = COMMENTS_PER_PAGE): number[] {
  const last = Math.max(1, Math.ceil(commentCount / perPage));
  const onLastPage = commentCount - (last - 1) * perPage;
  return last > 1 && onLastPage < perPage ? [last - 1, last] : [last];
}

/**
 * The handled re-read (ADR 0005 decision 3): the issue's newest comments — the last page and, when it is short, the
 * one before it, so at least the newest 100 are seen (#270) — for a trusted, unedited `pt-owner-request-handled`
 * marker a missed webhook delivery would have brought. A failed read keeps the request pending; the form never
 * fails over it. The only D1 write of the GET, and a row changes on nothing but a trusted bot's strict marker
 * (`handledRequestOf`, `markHandled`) — which is why the service identity may reach it.
 */
async function rereadHandled(
  c: Context,
  client: GitHubClient,
  repo: RepoName,
  slug: string,
  number: number,
  issue: LiveIssue,
): Promise<void> {
  let comments: GitHubComment[];
  try {
    const pages = await Promise.all(
      rereadPagesOf(issue.comments).map((page) =>
        client.getJson(
          githubPath`/repos/${repo}/issues/${number}/comments?per_page=${COMMENTS_PER_PAGE}&page=${page}`,
          (value: unknown): value is unknown => Array.isArray(value),
        ),
      ),
    );
    comments = pages.flatMap(commentsOf);
  } catch (error: unknown) {
    if (!(error instanceof GitHubError)) {
      throw error;
    }
    c.get('logger').warn('owner request: handled re-read failed', {
      slug,
      issue: number,
      status: error.githubStatus,
    });
    return;
  }
  const requests = new OwnerRequestsRepo(c.env.DB);
  for (const comment of comments) {
    const handled = handledRequestOf(comment, true);
    if (handled !== null) {
      await requests.markHandled({ ...handled, slug, issueNumber: number });
    }
  }
}

/**
 * Owner requests to the PM (#219, ADR 0005, architect note on #29 §3). `POST …/issues/:number/request` posts one
 * comment on the owner's token — the `pt-owner-request` marker, a human line in `owner.language`, the italic
 * trailer — and writes no milestone, label or status. Owner-only: the service identity gets 403 before any read.
 * The form sends the milestone it showed; another live one is 409 `issue-changed` with the live title. A repeat
 * within 60 s is answered from `own_writes`. The D1 row is a display cache: it never decides a write.
 * Subrequests (POST): token ≤ 2 + issue 1 + milestones 1 + project.yml 1 (cached) + repo 1 + comment 1 → ≤ 7.
 * `GET …/issues/:number/request` reads the issue, the sprints and D1, and while pending the newest comments (one or
 * two pages) for a handled marker → ≤ 7.
 */
export function createOwnerRequestRoutes(github: ApiGitHub): Hono<WorkerHonoEnv<ApiEnv>> {
  return new Hono<WorkerHonoEnv<ApiEnv>>()
    .get('/:slug/issues/:number/request', async (c) => {
      const project = await findProject(c, c.req.param('slug'));
      if (project === null) {
        return projectNotFound(c);
      }
      const repo = repoOf(c, project);
      if (repo instanceof Response) {
        return repo;
      }
      const rawNumber = c.req.param('number');
      if (!ISSUE_NUMBER.test(rawNumber)) {
        return invalid(c, 'The issue number must be a positive integer');
      }
      const number = Number(rawNumber);
      const installation = await github.connect(c.env);
      const reader = repositoryClient(installation, repo);
      const reads = new ProjectReads(github, c.env, project, repo, github.now, installation);
      const [issue, milestones, file] = await Promise.all([
        readIssue(reader, repo, number),
        readAllMilestones(reader, repo),
        reads.projectYmlFile(),
      ]);
      if (issue === null) {
        throw githubUnexpectedError('the issue answer had an unexpected shape');
      }
      if (issue.isPullRequest) {
        return problem(c, { type: 'request-not-issue', title: 'This is a pull request', status: 422 });
      }
      const plan = sprintPlanOf(milestones, sprintToday(github.now()), freezeDaysOfFile(file));
      const requests = new OwnerRequestsRepo(c.env.DB);
      let latest: OwnerRequestRecord | null = await requests.latestFor(project.slug, number);
      if (latest !== null && latest.result === null && issue.comments > 0) {
        await rereadHandled(c, reader, repo, project.slug, number, issue);
        latest = await requests.latestFor(project.slug, number);
      }
      const body: IssueRequestDto = {
        number,
        title: issue.title,
        state: issue.state,
        milestone: issue.milestone,
        current: plan.current,
        next: plan.next,
        freezeNow: plan.current !== null && isInFreeze(plan.today, freezeOfDue(plan, plan.current.due)),
        request: latest === null ? null : requestStatusOf(latest),
      };
      c.header('Cache-Control', 'no-store');
      return c.json(body);
    })

    .post(
      '/:slug/issues/:number/request',
      ownerOnlyMiddleware,
      bodyLimit({ maxSize: MAX_BODY_BYTES }),
      async (c) => {
        const project = await findProject(c, c.req.param('slug'));
        if (project === null) {
          return projectNotFound(c);
        }
        const repo = repoOf(c, project);
        if (repo instanceof Response) {
          return repo;
        }
        const rawNumber = c.req.param('number');
        if (!ISSUE_NUMBER.test(rawNumber)) {
          return invalid(c, 'The issue number must be a positive integer');
        }
        const number = Number(rawNumber);
        const parsed = parseOwnerRequest(await jsonBody(c));
        if (typeof parsed === 'string') {
          return invalid(c, parsed);
        }
        // D1 only: no connection is 403 github-owner-not-connected before GitHub is asked anything.
        await (await github.ownerConnection(c.env, c.get('logger'))).account();
        const installation = await github.connect(c.env);
        const reader = repositoryClient(installation, repo);
        const reads = new ProjectReads(github, c.env, project, repo, github.now, installation);
        const needsSprints = parsed.request.kind === 'sprint' && parsed.request.target !== 'backlog';
        const [issue, milestones, file] = await Promise.all([
          readIssue(reader, repo, number),
          needsSprints ? readAllMilestones(reader, repo) : Promise.resolve([]),
          reads.projectYmlFile(),
        ]);
        if (issue === null) {
          throw githubUnexpectedError('the issue answer had an unexpected shape');
        }
        if (issue.isPullRequest) {
          return problem(c, { type: 'request-not-issue', title: 'This is a pull request', status: 422 });
        }
        if (issue.state !== 'open') {
          return problem(c, {
            type: 'issue-closed',
            title: 'The issue is closed',
            status: 409,
            detail: 'Nothing is recorded on a closed issue',
          });
        }
        if (issue.milestone !== parsed.expectedMilestone) {
          return problem(c, {
            type: 'issue-changed',
            title: 'The issue changed meanwhile',
            status: 409,
            detail: 'Check its sprint and send again',
            extensions: { milestone: issue.milestone },
          });
        }
        if (needsSprints) {
          const refused = sprintRefusal(
            c,
            parsed.request,
            sprintPlanOf(milestones, sprintToday(github.now()), freezeDaysOfFile(file)),
          );
          if (refused !== null) {
            return refused;
          }
        }
        const language = file === null || file.text === null ? 'ru' : ownerLanguageOf(file.text);
        const body = requestComment({
          request: parsed.request,
          language,
          ...(parsed.ownerSaid === undefined ? {} : { ownerSaid: parsed.ownerSaid }),
        });
        const target = { repo, registered: project.repo, number, body, kind: 'request' as const };
        const fields = {
          slug: project.slug,
          issue: number,
          request: parsed.request.kind,
          identity: c.get('identity').kind,
        };
        const outcome = await postOwnerAnswer(c, github, target, {
          writer: async () => ownerWriter(c.env, c.get('logger'), github, installation, target),
          recheck: async () => null,
          fields,
        });
        if (outcome.kind === 'in-progress') {
          return problem(c, REQUEST_IN_PROGRESS);
        }
        if (outcome.kind === 'refused') {
          return outcome.response;
        }
        const { write } = outcome;
        const requestedAt = await requestedAtOf(c, outcome, fields);
        try {
          await new OwnerRequestsRepo(c.env.DB).record({
            commentId: write.commentId,
            slug: project.slug,
            issueNumber: number,
            kind: parsed.request.kind,
            payload: requestMarker(parsed.request).slice('<!-- pt-owner-request '.length, -' -->'.length),
            url: write.url,
            requestedAt,
          });
        } catch (error: unknown) {
          // The comment exists: an error would invite a retry. The board just misses the badge until a rebuild.
          c.get('logger').error('owner request written but not indexed', { ...fields, error });
        }
        const response: OwnerRequestResponse = {
          commentId: write.commentId,
          url: write.url,
          requestedAt,
          replayed: outcome.kind === 'replayed',
        };
        if (outcome.kind === 'replayed') {
          c.header('Idempotent-Replayed', 'true');
        }
        c.header('Cache-Control', 'no-store');
        return c.json(response, outcome.kind === 'replayed' ? 200 : 201);
      },
    );
}
