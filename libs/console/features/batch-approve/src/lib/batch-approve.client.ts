import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { commandFailureOf, type CommandFailureKind } from '@console/entities/team-run';
import {
  ANSWER_TEXT_MAX_LENGTH,
  BATCH_ANSWER_MAX,
  isProblemDetails,
  problemSlugOf,
  type BatchAnswerRequest,
  type BatchAnswerResult,
} from '@shared/contracts';
import { firstValueFrom } from 'rxjs';

export function batchAnswerUrl(slug: string): string {
  return `/api/v1/projects/${encodeURIComponent(slug)}/answers/batch`;
}

/**
 * Why a batch or one of its items was not recorded, as the dialog words it. `retryable`: the same request again may
 * go through (and replays whatever was written); `changed`: the item is no longer what the owner saw, so it leaves
 * the batch to be answered one by one.
 */
export type BatchFailureKind = 'connect' | 'rate' | 'offline' | 'github' | 'changed';

/** Problem slugs that mean the item itself changed on GitHub: a retry cannot help. */
const CHANGED: ReadonlySet<string> = new Set([
  'batch-not-safe',
  'issue-closed',
  'answer-not-waiting',
  'answer-not-allowed',
  'github-not-found',
]);

const BY_SLUG: Readonly<Record<string, BatchFailureKind>> = {
  'github-owner-not-connected': 'connect',
  'github-owner-mismatch': 'connect',
  'github-rate-limit': 'rate',
};

/** The kind behind a problem slug (a whole request's or one item's); anything unknown is worth a retry. */
export function batchFailureKindOf(slug: string | null): BatchFailureKind {
  if (slug === null) {
    return 'github';
  }
  if (CHANGED.has(slug)) {
    return 'changed';
  }
  return BY_SLUG[slug] ?? 'github';
}

// A whole request's failure as the team commands read it (#114, `@console/entities/team-run`), in the batch's words.
const BY_COMMAND_FAILURE: Partial<Readonly<Record<CommandFailureKind, BatchFailureKind>>> = {
  'not-connected': 'connect',
  'github-rate-limited': 'rate',
  offline: 'offline',
};

export type BatchSubmitResult =
  | { readonly ok: true; readonly results: readonly BatchAnswerResult[] }
  | { readonly ok: false; readonly failure: BatchFailureKind };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isResult(value: unknown): value is BatchAnswerResult {
  if (!isRecord(value) || !Number.isSafeInteger(value['number'])) {
    return false;
  }
  if (value['ok'] === true) {
    return (
      Number.isSafeInteger(value['commentId']) &&
      typeof value['url'] === 'string' &&
      typeof value['replayed'] === 'boolean'
    );
  }
  return value['ok'] === false && isProblemDetails(value['problem']);
}

/** The response, kept only when it has one result for every number asked, in the same order. */
export function batchResultsOf(
  value: unknown,
  numbers: readonly number[],
): readonly BatchAnswerResult[] | null {
  if (!isRecord(value) || !Array.isArray(value['results'])) {
    return null;
  }
  const results: unknown[] = value['results'];
  if (results.length !== numbers.length || !results.every(isResult)) {
    return null;
  }
  return results.every((result, index) => result.number === numbers[index]) ? results : null;
}

/** The slug of a failed item's problem, never its title or detail. */
export function itemSlugOf(result: BatchAnswerResult): string | null {
  return result.ok ? null : problemSlugOf(result.problem.type);
}

/**
 * `POST /api/v1/projects/:slug/answers/batch` (#220): one request per project. Never throws: every outcome is a
 * `BatchSubmitResult`. A repeat of the same body is safe — the Worker replays every item it already wrote within
 * 60 s, and holds off an item whose earlier write may have reached GitHub.
 */
@Injectable({ providedIn: 'root' })
export class BatchApproveClient {
  private readonly http = inject(HttpClient);

  async submit(slug: string, request: BatchAnswerRequest): Promise<BatchSubmitResult> {
    if (request.numbers.length === 0 || request.numbers.length > BATCH_ANSWER_MAX) {
      throw new Error(`a batch takes 1 to ${BATCH_ANSWER_MAX} questions`);
    }
    if (request.ownerSaid.length > ANSWER_TEXT_MAX_LENGTH) {
      throw new Error(`the owner's words are longer than ${ANSWER_TEXT_MAX_LENGTH} characters`);
    }
    let answer: unknown;
    try {
      answer = await firstValueFrom(this.http.post<unknown>(batchAnswerUrl(slug), request));
    } catch (error: unknown) {
      if (!(error instanceof HttpErrorResponse)) {
        throw error;
      }
      return { ok: false, failure: BY_COMMAND_FAILURE[commandFailureOf(error).kind] ?? 'github' };
    }
    const results = batchResultsOf(answer, request.numbers);
    // A 2xx we cannot read: some items may be written; the retry the dialog offers is answered from the replay.
    return results === null ? { ok: false, failure: 'github' } : { ok: true, results };
  }
}
