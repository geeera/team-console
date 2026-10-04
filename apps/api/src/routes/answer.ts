import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  ANSWER_TEXT_MAX_LENGTH,
  type AnswerCommand,
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
import { OwnWritesRepo, type OwnWrite } from '@worker/db';
import { githubPath, type RepoName } from '@worker/github';
import { refuseServiceWrite } from '../auth/service-write-gate';
import type { ApiEnv } from '../env';
import type { ApiGitHub, GitHubConnection } from '../github';
import { jsonBody } from '../json-body';
import { isNotWritten, ownerWriter, sha256Hex } from '../owner/owner-writer';
import { findProject, projectNotFound, repoOf } from '../projects/lookup';
import { repositoryClient } from '../projects/repository-checks';

type Context = WorkerContext<ApiEnv>;

/** A repeat of the same answer within this window is answered from `own_writes`, not posted again (decision 19). */
export const REPLAY_WINDOW_MS = 60_000;
// Two taps that arrive together: the second waits this long for the first to be recorded, then answers 409.
const CLAIM_WAIT_ATTEMPTS = 5;
const CLAIM_WAIT_MS = 200;
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
  /** `null` for a deleted account; only the service-identity gate reads it. */
  readonly user?: unknown;
}

interface GitHubComment {
  readonly id: number;
  readonly html_url: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIssue(value: unknown): value is GitHubIssue {
  return isRecord(value) && typeof value['state'] === 'string' && Array.isArray(value['labels']);
}

function isComment(value: unknown): value is GitHubComment {
  return isRecord(value) && Number.isSafeInteger(value['id']) && typeof value['html_url'] === 'string';
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

function authorOf(issue: GitHubIssue): { authorLogin: string | null; authorType: string | null } {
  const user = issue.user;
  if (!isRecord(user)) {
    return { authorLogin: null, authorType: null };
  }
  return {
    authorLogin: typeof user['login'] === 'string' ? user['login'] : null,
    authorType: typeof user['type'] === 'string' ? user['type'] : null,
  };
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

interface WriteTarget {
  readonly repo: RepoName;
  readonly registered: string;
  readonly number: number;
  readonly body: string;
}

/** The comment on the owner's token (see `ownerWriter`); `onSent` marks the moment GitHub may have written it. */
async function writeAsOwner(
  c: Context,
  github: ApiGitHub,
  installation: GitHubConnection,
  target: WriteTarget,
  onSent: () => void,
): Promise<GitHubComment> {
  const writer = await ownerWriter(c.env, c.get('logger'), github, installation, target);
  onSent();
  return writer.postJson(
    githubPath`/repos/${target.repo}/issues/${target.number}/comments`,
    { body: target.body },
    isComment,
  );
}

/**
 * `POST /api/v1/projects/:slug/issues/:number/answer` (#10): the owner's answer to an issue in their inbox, written
 * as the plugin's `backlog answer` writes it, as the owner. Behind Access and CSRF like every `/api` route, and
 * owner-grade: the dev/stage CI service identity answers only on an `e2e:fixture` issue that is not a release, a
 * design or a question the team asked (#62), decided on the live labels before the owner token is touched.
 * Section and allowed commands come from the live issue, never from the client; nothing is written on any 4xx.
 */
export function createAnswerRoutes(github: ApiGitHub): Hono<WorkerHonoEnv<ApiEnv>> {
  return new Hono<WorkerHonoEnv<ApiEnv>>().post(
    '/:slug/issues/:number/answer',
    bodyLimit({ maxSize: MAX_BODY_BYTES }),
    async (c) => {
      const logger = c.get('logger');
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
      const request = parseAnswer(await jsonBody(c));
      if (typeof request === 'string') {
        return invalid(c, request);
      }

      // Uncached on purpose: a stale label set could accept a command the issue no longer takes, or let the service
      // identity past the fixture gate on an issue that just lost `e2e:fixture`.
      const installation = await github.connect(c.env);
      const issue = await repositoryClient(installation, repo).getJson(
        githubPath`/repos/${repo}/issues/${number}`,
        isIssue,
      );
      const labels = labelNames(issue);
      const refused = refuseServiceWrite(c, { labels, ...authorOf(issue) }, repo);
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
      const fields = {
        slug: project.slug,
        issue: number,
        command: request.command,
        identity: c.get('identity').kind,
      };
      if (section === null) {
        // answerComment refuses a null section; this keeps the type narrow for the response.
        throw new Error('an answer was composed for an issue without a section');
      }

      const writes = new OwnWritesRepo(c.env.DB);
      const bodyHash = await sha256Hex(`${project.repo}\n${number}\n${body}`);
      const recent = async (): Promise<OwnWrite | null> =>
        writes.findRecentByHash(
          project.repo,
          number,
          bodyHash,
          new Date(github.now() - REPLAY_WINDOW_MS).toISOString(),
        );
      const replay = async (write: OwnWrite): Promise<Response> => {
        logger.info('owner answer replayed', fields);
        return answered(c, write, section, request.command, true);
      };

      const previous = await recent();
      if (previous !== null) {
        return replay(previous);
      }
      if (!(await writes.claim(bodyHash, github.now(), REPLAY_WINDOW_MS))) {
        for (let attempt = 0; attempt < CLAIM_WAIT_ATTEMPTS; attempt += 1) {
          await github.pause(CLAIM_WAIT_MS);
          const settled = await recent();
          if (settled !== null) {
            return replay(settled);
          }
        }
        logger.warn('owner answer already in flight', fields);
        return problem(c, {
          type: 'answer-in-progress',
          title: 'The same answer is being written',
          status: 409,
          retryAfter: 2,
        });
      }

      let isSent = false;
      let comment: GitHubComment;
      try {
        comment = await writeAsOwner(
          c,
          github,
          installation,
          { repo, registered: project.repo, number, body },
          () => {
            isSent = true;
          },
        );
      } catch (error: unknown) {
        if (!isSent || isNotWritten(error)) {
          await writes.release(bodyHash);
        } else {
          logger.warn('owner answer may have been written; a repeat is held for the replay window', fields);
        }
        throw error;
      }

      const write: OwnWrite = {
        commentId: comment.id,
        repo: project.repo,
        issueNumber: number,
        kind: 'answer',
        bodyHash,
        url: comment.html_url,
        createdAt: new Date(github.now()).toISOString(),
      };
      try {
        await writes.record(write);
        await writes.release(bodyHash);
      } catch (error: unknown) {
        // The comment exists: answering an error would invite a retry that posts it again. The claim (if it could
        // not be released) still holds a repeat off for the replay window.
        logger.error('owner answer written but not recorded', { ...fields, error });
      }
      logger.info('owner answer written', fields);
      return answered(c, write, section, request.command, false);
    },
  );
}
