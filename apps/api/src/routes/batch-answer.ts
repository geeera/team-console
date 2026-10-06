import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  ANSWER_TEXT_MAX_LENGTH,
  BATCH_ANSWER_MAX,
  type BatchAnswerRequest,
  type BatchAnswerResponse,
  type BatchAnswerResult,
  type BatchLeftOutReason,
} from '@shared/contracts';
import {
  GrammarError,
  allowedAnswers,
  answerComment,
  askOf,
  batchVerdictOf,
  categoryOf,
  kindOf,
  recommendationOf,
  sectionOf,
} from '@shared/owner-grammar';
import { problem, problemBody, type ProblemInit, type WorkerContext, type WorkerHonoEnv } from '@worker/core';
import { GitHubError, githubPath, type GitHubClient, type RepoName } from '@worker/github';
import { isGitHubIssue, isTrustedAuthor, issueRecordOf } from '@worker/read-models';
import { ownerOnlyMiddleware } from '../auth/owner-only.middleware';
import type { ApiEnv } from '../env';
import type { ApiGitHub } from '../github';
import { jsonBody } from '../json-body';
import { ownerWriter } from '../owner/owner-writer';
import { ANSWER_IN_PROGRESS, postOwnerAnswer } from '../owner/post-owner-answer';
import { findProject, projectNotFound, repoOf } from '../projects/lookup';
import { repositoryClient } from '../projects/repository-checks';
import { SubrequestBudget } from '../read-models/subrequest-budget';

type Context = WorkerContext<ApiEnv>;

/**
 * GitHub subrequests one batch may spend (Workers free plan: 50 per request; the rest is the margin for what the
 * budget does not count — an owner-token refresh, a mint after a 401). Installation token ≤ 2 + the repository read
 * of the owner check 1 + per item the issue read and the comment 2: 15 items need 33.
 */
export const BATCH_GITHUB_BUDGET = 44;
const ITEM_COST = 2;
// ownerSaid at up to 3 UTF-8 bytes per code unit with JSON escapes, and 15 numbers.
const MAX_BODY_BYTES = 16 * 1024;
const MAX_ISSUE_NUMBER = 9_999_999_999;
const FIELDS: ReadonlySet<string> = new Set(['numbers', 'ownerSaid']);

const NOT_SAFE_DETAIL: Readonly<Record<BatchLeftOutReason, string>> = {
  untrusted: 'The issue was opened by someone outside the team',
  money: 'The question is about money',
  release: 'The issue is a release decision',
  legal: 'The question is about legal exposure',
  access: 'The question is about accounts, secrets or permissions',
  design: 'The issue is a design to look at first',
  uncategorised: 'The question carries no owner:* category',
  reject: 'The team recommends rejecting; that needs the owner’s reason',
  'no-recommendation': 'The answer line recommends no approval',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIssueNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= MAX_ISSUE_NUMBER;
}

/** `BatchAnswerRequest`, or why not. Nothing of the input is echoed back. */
function parseBatch(body: unknown): BatchAnswerRequest | string {
  if (!isRecord(body)) {
    return 'The body must be a JSON object with numbers and ownerSaid';
  }
  if (Object.keys(body).some((key) => !FIELDS.has(key))) {
    return 'Only numbers and ownerSaid may be sent';
  }
  const { numbers, ownerSaid } = body;
  if (!Array.isArray(numbers) || numbers.length === 0 || numbers.length > BATCH_ANSWER_MAX) {
    return `numbers must list 1 to ${BATCH_ANSWER_MAX} issue numbers`;
  }
  if (!numbers.every(isIssueNumber)) {
    return 'numbers must be positive integer issue numbers';
  }
  if (new Set(numbers).size !== numbers.length) {
    return 'numbers must not repeat an issue';
  }
  if (typeof ownerSaid !== 'string' || ownerSaid.trim() === '' || ownerSaid.length > ANSWER_TEXT_MAX_LENGTH) {
    return `ownerSaid must be words of at most ${ANSWER_TEXT_MAX_LENGTH} characters`;
  }
  return { numbers, ownerSaid };
}

interface BatchContext {
  readonly c: Context;
  readonly github: ApiGitHub;
  readonly budget: SubrequestBudget;
  /** Uncounted: each item takes its two subrequests from the budget before it reads anything. */
  readonly reader: GitHubClient;
  readonly writer: GitHubClient;
  readonly repo: RepoName;
  readonly registered: string;
  readonly slug: string;
  readonly ownerSaid: string;
}

/**
 * One item of the batch, decided again on the live issue — the client's list is never trusted: open, a question
 * about scope from a trusted author that the team recommends approving (`batchVerdictOf`, the rule the read models
 * and the client use), then `backlog answer approve`'s comment through `postOwnerAnswer`. Every refusal and every
 * GitHub failure is this item's result; the others go on.
 */
async function answerItem(batch: BatchContext, number: number): Promise<BatchAnswerResult> {
  const { c, github, repo } = batch;
  const failed = (init: ProblemInit): BatchAnswerResult => ({
    number,
    ok: false,
    problem: problemBody(init, c.get('requestId')),
  });
  try {
    // Reserved before the first read, so an item is either attempted whole or not at all.
    batch.budget.spend(ITEM_COST);
    const raw = await batch.reader.getJson(githubPath`/repos/${repo}/issues/${number}`, isGitHubIssue);
    const issue = issueRecordOf(raw);
    if (issue.state !== 'open') {
      return failed({
        type: 'issue-closed',
        title: 'The issue is closed',
        status: 409,
        detail: 'Nothing is waiting for an answer on a closed issue',
      });
    }
    // The plugin's inbox drops pull requests; nothing on one waits for an answer.
    const section = issue.isPullRequest ? null : sectionOf(issue.labels, kindOf(issue.labels));
    if (section !== null) {
      const verdict = batchVerdictOf({
        section,
        category: categoryOf(issue.labels),
        recommendation: recommendationOf(askOf(issue.body) || null),
        authorTrusted: isTrustedAuthor(issue),
      });
      if (verdict.kind === 'left-out') {
        return failed({
          type: 'batch-not-safe',
          title: 'Not safe to approve in a batch',
          status: 422,
          detail: NOT_SAFE_DETAIL[verdict.reason],
          extensions: { reason: verdict.reason },
        });
      }
    }
    let body: string;
    try {
      body = answerComment({ command: 'approve', ownerSaid: batch.ownerSaid, section, via: 'console' });
    } catch (error: unknown) {
      if (!(error instanceof GrammarError)) {
        throw error;
      }
      return failed({
        type: `answer-${error.code}`,
        title: 'The issue does not take this answer',
        status: 422,
        extensions: { section, allowed: allowedAnswers(section) },
      });
    }
    const outcome = await postOwnerAnswer(
      c,
      github,
      { repo, registered: batch.registered, number, body },
      {
        writer: async () => batch.writer,
        // The service identity never reaches this route (owner-only), so there is no fixture gate to re-check.
        recheck: async () => null,
        fields: {
          slug: batch.slug,
          issue: number,
          command: 'approve',
          batch: true,
          identity: c.get('identity').kind,
        },
      },
    );
    switch (outcome.kind) {
      case 'written':
      case 'replayed':
        return {
          number,
          ok: true,
          commentId: outcome.write.commentId,
          url: outcome.write.url,
          replayed: outcome.kind === 'replayed',
        };
      case 'in-progress':
        return failed(ANSWER_IN_PROGRESS);
      case 'refused':
        throw new Error('a batch answer was refused by a re-check it does not run');
    }
  } catch (error: unknown) {
    if (!(error instanceof GitHubError)) {
      throw error;
    }
    c.get('logger').warn('owner batch item failed', {
      slug: batch.slug,
      issue: number,
      type: error.problem.type,
      githubStatus: error.githubStatus,
    });
    return failed(error.problem);
  }
}

/**
 * `POST /api/v1/projects/:slug/answers/batch` (#220): the owner approves the team's recommendation on up to 15
 * questions in one confirmation. Owner-only: the dev/stage service identity gets 403 `owner-only` before any GitHub
 * call (it could not answer a question anyway, #193). The owner connection and the repository's owner are checked
 * once for the whole request, before any item (403 `github-owner-not-connected`, 409 `github-owner-mismatch`); then
 * every item is answered in order on its own and the request is 200 with one result per number. An item the
 * subrequest budget cannot cover is `github-request-budget`, never half-attempted.
 */
export function createBatchAnswerRoutes(github: ApiGitHub): Hono<WorkerHonoEnv<ApiEnv>> {
  return new Hono<WorkerHonoEnv<ApiEnv>>().post(
    '/:slug/answers/batch',
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
      const request = parseBatch(await jsonBody(c));
      if (typeof request === 'string') {
        return problem(c, { type: 'validation', title: 'Invalid request', status: 422, detail: request });
      }

      const budget = new SubrequestBudget(BATCH_GITHUB_BUDGET);
      const installation = await github.connect(c.env);
      const counted = await budget.connectionFor(installation, repo);
      // Throws the whole request's 403/409 before any item is read or written.
      const writer = await ownerWriter(c.env, c.get('logger'), github, counted, {
        repo,
        registered: project.repo,
      });
      const batch: BatchContext = {
        c,
        github,
        budget,
        reader: repositoryClient(installation, repo),
        writer,
        repo,
        registered: project.repo,
        slug: project.slug,
        ownerSaid: request.ownerSaid,
      };
      const results: BatchAnswerResult[] = [];
      for (const number of request.numbers) {
        results.push(await answerItem(batch, number));
      }
      c.get('logger').info('owner batch answered', {
        slug: project.slug,
        items: results.length,
        failed: results.filter((result) => !result.ok).length,
        subrequests: budget.spent,
      });
      const response: BatchAnswerResponse = { results };
      c.header('Cache-Control', 'no-store');
      return c.json(response, 200);
    },
  );
}
