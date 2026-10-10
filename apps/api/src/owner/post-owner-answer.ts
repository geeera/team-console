import type { LogFields, ProblemInit, WorkerContext } from '@worker/core';
import { OwnWritesRepo, type OwnWrite, type OwnWriteKind } from '@worker/db';
import { githubPath, type GitHubClient, type RepoName } from '@worker/github';
import type { ApiEnv } from '../env';
import type { ApiGitHub } from '../github';
import { isNotWritten, sha256Hex } from './owner-writer';

/**
 * Posting one owner answer on an issue, shared by the answer route (#10) and the batch route (#220): the 60 s replay
 * from `own_writes`, the claim that holds a second tap off while the first is in flight, the comment on the owner's
 * token, and the record. The caller has already decided that the issue takes this answer and composed `body`.
 */

/** A repeat of the same answer within this window is answered from `own_writes`, not posted again (decision 19). */
export const REPLAY_WINDOW_MS = 60_000;
// Two taps that arrive together: the second waits this long for the first to be recorded, then gives up.
const CLAIM_WAIT_ATTEMPTS = 5;
const CLAIM_WAIT_MS = 200;

/** The same answer is being written by another request right now; a retry in a moment is answered by the replay. */
export const ANSWER_IN_PROGRESS: ProblemInit = {
  type: 'answer-in-progress',
  title: 'The same answer is being written',
  status: 409,
  retryAfter: 2,
};

export interface OwnerAnswerTarget {
  readonly repo: RepoName;
  /** `owner/name` as the registry stores it: the key of `own_writes` and the owner check. */
  readonly registered: string;
  readonly number: number;
  /** The comment, byte for byte (`answerComment`, `requestComment`). */
  readonly body: string;
  /** What `own_writes` records it as: an answer (#10, #220) or an owner request to the PM (#219). */
  readonly kind: Extract<OwnWriteKind, 'answer' | 'request'>;
}

export interface OwnerAnswerSteps {
  /** The owner's client (`ownerWriter`). Called after the claim, so a refusal there releases it. */
  readonly writer: () => Promise<GitHubClient>;
  /** Runs last before the POST, after the token work; a response stops the write and is handed back. */
  readonly recheck: () => Promise<Response | null>;
  /** What every log line of this answer carries (no issue text, no token). */
  readonly fields: LogFields;
}

export type OwnerAnswerOutcome =
  /** `createdAt`: GitHub's `created_at` of the new comment, `null` when the answer carried none. */
  | { readonly kind: 'written'; readonly write: OwnWrite; readonly createdAt: string | null }
  | { readonly kind: 'replayed'; readonly write: OwnWrite }
  | { readonly kind: 'in-progress' }
  | { readonly kind: 'refused'; readonly response: Response };

interface GitHubComment {
  readonly id: number;
  readonly html_url: string;
  readonly created_at?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isComment(value: unknown): value is GitHubComment {
  return isRecord(value) && Number.isSafeInteger(value['id']) && typeof value['html_url'] === 'string';
}

/**
 * GitHub's timestamp of the comment as ISO 8601 UTC, or `null` when the answer lacks one it can parse. Never a
 * reason to fail: the comment exists by now, and a thrown error would invite a second post.
 */
function githubCreatedAtOf(comment: GitHubComment): string | null {
  if (typeof comment.created_at !== 'string' || !Number.isFinite(Date.parse(comment.created_at))) {
    return null;
  }
  return new Date(comment.created_at).toISOString();
}

/**
 * The answer, written once. A GitHub failure is thrown (the caller maps it); the claim is released when GitHub
 * certainly did not write, and kept for the replay window when it may have (a timeout, a 5xx), so a repeat is held
 * off instead of posting a second comment.
 */
export async function postOwnerAnswer(
  c: WorkerContext<ApiEnv>,
  github: ApiGitHub,
  target: OwnerAnswerTarget,
  steps: OwnerAnswerSteps,
): Promise<OwnerAnswerOutcome> {
  const logger = c.get('logger');
  const { fields } = steps;
  const writes = new OwnWritesRepo(c.env.DB);
  const bodyHash = await sha256Hex(`${target.registered}\n${target.number}\n${target.body}`);
  const recent = async (): Promise<OwnWrite | null> =>
    writes.findRecentByHash(
      target.registered,
      target.number,
      bodyHash,
      new Date(github.now() - REPLAY_WINDOW_MS).toISOString(),
    );
  const replay = (write: OwnWrite): OwnerAnswerOutcome => {
    logger.info('owner answer replayed', fields);
    return { kind: 'replayed', write };
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
    return { kind: 'in-progress' };
  }

  let isSent = false;
  let comment: GitHubComment;
  try {
    const writer = await steps.writer();
    const refused = await steps.recheck();
    if (refused !== null) {
      await writes.release(bodyHash);
      return { kind: 'refused', response: refused };
    }
    isSent = true;
    comment = await writer.postJson(
      githubPath`/repos/${target.repo}/issues/${target.number}/comments`,
      { body: target.body },
      isComment,
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
    repo: target.registered,
    issueNumber: target.number,
    kind: target.kind,
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
  return { kind: 'written', write, createdAt: githubCreatedAtOf(comment) };
}
