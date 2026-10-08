import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  ANSWER_LOOKUP_MAX_MS,
  ANSWER_TEXT_MAX_LENGTH,
  type AnswerCommand,
  type AnswerLookupResponse,
  type AnswerResponse,
  type Section,
} from '@shared/contracts';
import {
  GrammarError,
  allowedAnswers,
  answerComment,
  isAnswerCommand,
  kindOf,
  sectionOf,
} from '@shared/owner-grammar';
import { problem, type WorkerContext, type WorkerHonoEnv } from '@worker/core';
import { OwnerConnectionsRepo, OwnWritesRepo, type OwnWrite, type ProjectRow } from '@worker/db';
import { githubPath, type GitHubClient, type RepoName } from '@worker/github';
import {
  isIssueEvent,
  isIssueEventsPage,
  refuseServiceWrite,
  refuseServiceWriteOnRecheck,
} from '../auth/service-write-gate';
import type { ApiEnv } from '../env';
import type { ApiGitHub, GitHubConnection } from '../github';
import { jsonBody } from '../json-body';
import { ownerWriter } from '../owner/owner-writer';
import {
  ANSWER_IN_PROGRESS,
  REPLAY_WINDOW_MS,
  answerBodyHash,
  postOwnerAnswer,
} from '../owner/post-owner-answer';
import { findProject, projectNotFound, repoOf } from '../projects/lookup';
import { repositoryClient } from '../projects/repository-checks';

export { REPLAY_WINDOW_MS } from '../owner/post-owner-answer';

type Context = WorkerContext<ApiEnv>;

// Two strings of ANSWER_TEXT_MAX_LENGTH code units at up to 3 UTF-8 bytes each, JSON escapes, and the command.
const MAX_BODY_BYTES = 16 * 1024;
const ISSUE_NUMBER = /^[1-9][0-9]{0,9}$/;
const FIELDS: ReadonlySet<string> = new Set(['command', 'text', 'ownerSaid']);

interface ParsedAnswer {
  readonly command: AnswerCommand;
  readonly text: string;
  readonly ownerSaid: string;
}

interface GitHubIssue {
  readonly state: string;
  readonly labels: readonly unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIssue(value: unknown): value is GitHubIssue {
  return isRecord(value) && typeof value['state'] === 'string' && Array.isArray(value['labels']);
}

/** GitHub sends labels as objects; a label without a string name is not one the plugin could have set. */
function labelNames(issue: GitHubIssue): string[] {
  return issue.labels.flatMap((label) => {
    if (typeof label === 'string') {
      return [label];
    }
    return isRecord(label) && typeof label['name'] === 'string' ? [label['name']] : [];
  });
}

/** The live labels of the issue, uncached: a stale set could accept a command or a write it no longer takes. */
async function readIssue(client: GitHubClient, repo: RepoName, number: number): Promise<GitHubIssue> {
  return client.getJson(githubPath`/repos/${repo}/issues/${number}`, isIssue);
}

/** `AnswerRequest`, or why not. Nothing of the input is echoed back. */
function parseAnswer(body: unknown): ParsedAnswer | string {
  if (!isRecord(body)) {
    return 'The body must be a JSON object with command and ownerSaid';
  }
  if (Object.keys(body).some((key) => !FIELDS.has(key))) {
    return 'Only command, text and ownerSaid may be sent';
  }
  const { command, text, ownerSaid } = body;
  if (!isAnswerCommand(command)) {
    return 'command must be one of approve, reject, go, no-go, override, done';
  }
  if (text !== undefined && (typeof text !== 'string' || text.length > ANSWER_TEXT_MAX_LENGTH)) {
    return `text must be a string of at most ${ANSWER_TEXT_MAX_LENGTH} characters`;
  }
  if (typeof ownerSaid !== 'string' || ownerSaid.length > ANSWER_TEXT_MAX_LENGTH) {
    return `ownerSaid must be a string of at most ${ANSWER_TEXT_MAX_LENGTH} characters`;
  }
  return { command, text: text ?? '', ownerSaid };
}

function invalid(c: Context, detail: string): Response {
  return problem(c, { type: 'validation', title: 'Invalid request', status: 422, detail });
}

function answered(
  c: Context,
  write: Pick<OwnWrite, 'commentId' | 'url'>,
  section: Section,
  command: AnswerCommand,
  replayed: boolean,
): Response {
  const body: AnswerResponse = { commentId: write.commentId, url: write.url, section, command, replayed };
  if (replayed) {
    c.header('Idempotent-Replayed', 'true');
  }
  c.header('Cache-Control', 'no-store');
  return c.json(body, replayed ? 200 : 201);
}

interface PreparedAnswer {
  readonly project: ProjectRow;
  readonly repo: RepoName;
  readonly number: number;
  readonly request: ParsedAnswer;
  readonly section: Section;
  readonly body: string;
  readonly installation: GitHubConnection;
  readonly reader: GitHubClient;
}

/**
 * What the answer route and its lookup decide before they touch `own_writes`: the project, the request, the live
 * issue (uncached on purpose: a stale label set could accept a command the issue no longer takes, or let the service
 * identity past the fixture gate on an issue that just lost `e2e:fixture`), the service identity's gate, and the
 * comment the answer composes to. A refusal is the response to send.
 */
async function prepareAnswer<T extends ParsedAnswer>(
  c: Context,
  github: ApiGitHub,
  parse: (body: unknown) => T | string,
): Promise<(PreparedAnswer & { readonly request: T }) | Response> {
  const project = await findProject(c, c.req.param('slug') ?? '');
  if (project === null) {
    return projectNotFound(c);
  }
  const repo = repoOf(c, project);
  if (repo instanceof Response) {
    return repo;
  }
  const rawNumber = c.req.param('number') ?? '';
  if (!ISSUE_NUMBER.test(rawNumber)) {
    return invalid(c, 'The issue number must be a positive integer');
  }
  const number = Number(rawNumber);
  const request = parse(await jsonBody(c));
  if (typeof request === 'string') {
    return invalid(c, request);
  }

  const installation = await github.connect(c.env);
  const reader = repositoryClient(installation, repo);
  const issue = await readIssue(reader, repo, number);
  const labels = labelNames(issue);
  const refused = await refuseServiceWrite(c, labels, {
    labelHistory: async () =>
      reader.lastPage(
        githubPath`/repos/${repo}/issues/${number}/events?per_page=${100}`,
        isIssueEvent,
        (url) => isIssueEventsPage(url, repo, number),
      ),
    ownerUserId: async () =>
      (await new OwnerConnectionsRepo(c.env.DB).find(c.env.ENVIRONMENT))?.user_id ?? null,
  });
  if (refused !== null) {
    return refused;
  }
  if (issue.state !== 'open') {
    return problem(c, {
      type: 'issue-closed',
      title: 'The issue is closed',
      status: 409,
      detail: 'Nothing is waiting for an answer on a closed issue',
    });
  }
  const section = sectionOf(labels, kindOf(labels));
  let body: string;
  try {
    body = answerComment({ ...request, section, via: 'console' });
  } catch (error: unknown) {
    if (!(error instanceof GrammarError)) {
      throw error;
    }
    return problem(c, {
      type: `answer-${error.code}`,
      title: 'The issue does not take this answer',
      status: 422,
      extensions: { section, allowed: allowedAnswers(section) },
    });
  }
  if (section === null) {
    // answerComment refuses a null section; this keeps the type narrow for the response.
    throw new Error('an answer was composed for an issue without a section');
  }
  return { project, repo, number, request, section, body, installation, reader };
}

interface ParsedLookup extends ParsedAnswer {
  readonly sentAgoMs: number;
}

/** `AnswerLookupRequest`, or why not: the answer's own fields as `parseAnswer` takes them, plus `sentAgoMs`. */
function parseLookup(body: unknown): ParsedLookup | string {
  if (!isRecord(body)) {
    return 'The body must be a JSON object with command, ownerSaid and sentAgoMs';
  }
  const { sentAgoMs, ...answer } = body;
  if (typeof sentAgoMs !== 'number' || !Number.isSafeInteger(sentAgoMs) || sentAgoMs < 0) {
    return 'sentAgoMs must be a non-negative integer';
  }
  if (sentAgoMs > ANSWER_LOOKUP_MAX_MS) {
    return `sentAgoMs must be at most ${ANSWER_LOOKUP_MAX_MS}`;
  }
  const parsed = parseAnswer(answer);
  return typeof parsed === 'string' ? parsed : { ...parsed, sentAgoMs };
}

/**
 * `POST /api/v1/projects/:slug/issues/:number/answer` (#10): the owner's answer to an issue in their inbox, written
 * as the plugin's `backlog answer` writes it, as the owner. Behind Access and CSRF like every `/api` route, and
 * owner-grade: the dev/stage CI service identity answers only on an issue the owner labelled `e2e:fixture` that is
 * not a release, a design or a question (#62, #193), decided on the live labels and the label's event history before
 * the owner token is touched, and the labels are read once more right before the comment is posted.
 * Subrequests: the owner's path is unchanged; the service identity adds one or two event reads and one label re-read
 * (plus one D1 read of the owner connection's pinned id, never its tokens).
 * Section and allowed commands come from the live issue, never from the client; nothing is written on any 4xx.
 * The write itself (replay, claim, comment, record) is `postOwnerAnswer`, shared with the batch route (#220).
 *
 * `POST …/answer/lookup` (#120) is the item re-read the console makes before it repeats an answer it first sent more
 * than the replay window ago (a response lost on the way back): the same live issue read, gate and problems when
 * the issue no longer takes the answer, and then — instead of a write — the comment the console already wrote with
 * exactly this answer since it was first sent (`own_writes`, `sentAgoMs` plus the replay window back, at most
 * `ANSWER_LOOKUP_MAX_MS`), or `null`. Nothing is written or claimed; one GitHub read for the owner.
 */
export function createAnswerRoutes(github: ApiGitHub): Hono<WorkerHonoEnv<ApiEnv>> {
  return new Hono<WorkerHonoEnv<ApiEnv>>()
    .post('/:slug/issues/:number/answer', bodyLimit({ maxSize: MAX_BODY_BYTES }), async (c) => {
      const prepared = await prepareAnswer(c, github, parseAnswer);
      if (prepared instanceof Response) {
        return prepared;
      }
      const { project, repo, number, request, section, body, installation, reader } = prepared;
      const target = { repo, registered: project.repo, number, body, kind: 'answer' as const };
      const outcome = await postOwnerAnswer(c, github, target, {
        writer: async () => ownerWriter(c.env, c.get('logger'), github, installation, target),
        recheck: async () =>
          refuseServiceWriteOnRecheck(c, async () => labelNames(await readIssue(reader, repo, number))),
        fields: {
          slug: project.slug,
          issue: number,
          command: request.command,
          identity: c.get('identity').kind,
        },
      });
      switch (outcome.kind) {
        case 'written':
        case 'replayed':
          return answered(c, outcome.write, section, request.command, outcome.kind === 'replayed');
        case 'in-progress':
          return problem(c, ANSWER_IN_PROGRESS);
        case 'refused':
          return outcome.response;
      }
    })
    .post('/:slug/issues/:number/answer/lookup', bodyLimit({ maxSize: MAX_BODY_BYTES }), async (c) => {
      const prepared = await prepareAnswer(c, github, parseLookup);
      if (prepared instanceof Response) {
        return prepared;
      }
      const { project, number, request, section, body } = prepared;
      const bodyHash = await answerBodyHash({ registered: project.repo, number, body, kind: 'answer' });
      const since = new Date(github.now() - request.sentAgoMs - REPLAY_WINDOW_MS).toISOString();
      const write = await new OwnWritesRepo(c.env.DB).findRecentByHash(project.repo, number, bodyHash, since);
      c.get('logger').info('owner answer looked up', {
        slug: project.slug,
        issue: number,
        command: request.command,
        identity: c.get('identity').kind,
        found: write !== null,
      });
      const response: AnswerLookupResponse = {
        answer:
          write === null
            ? null
            : {
                commentId: write.commentId,
                url: write.url,
                section,
                command: request.command,
                replayed: true,
              },
      };
      c.header('Cache-Control', 'no-store');
      return c.json(response, 200);
    });
}
