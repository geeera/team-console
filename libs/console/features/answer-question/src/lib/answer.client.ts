import { HttpClient, HttpErrorResponse, HttpResponse } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import {
  ANSWER_TEXT_MAX_LENGTH,
  type AnswerCommand,
  type AnswerRequest,
  type AnswerResponse,
  isProblemDetails,
  problemSlugOf,
} from '@shared/contracts';
import { isAnswerCommand, NEEDS_REASON } from '@shared/owner-grammar';
import { firstValueFrom } from 'rxjs';

export function answerUrl(slug: string, number: number): string {
  return `/api/v1/projects/${encodeURIComponent(slug)}/issues/${number}/answer`;
}

/** Why an answer was not recorded, as the card explains it. Each maps to `answer.error.<kind>` copy. */
export type AnswerFailureKind =
  | 'not-connected'
  | 'owner-mismatch'
  | 'app-not-installed'
  | 'issue-closed'
  | 'in-progress'
  | 'not-waiting'
  | 'not-allowed'
  | 'needs-reason'
  | 'rate-limited'
  | 'offline'
  | 'unknown';

/** What the card offers next: the same request again, a fresh list, or Settings. */
export type AnswerRecovery = 'retry' | 'refresh' | 'settings' | 'none';

export interface AnswerFailure {
  readonly kind: AnswerFailureKind;
  readonly recovery: AnswerRecovery;
  /** `Retry-After` in seconds, when the server sent one. */
  readonly retryAfter: number | null;
}

export type AnswerResult =
  | { readonly ok: true; readonly response: AnswerResponse }
  | { readonly ok: false; readonly failure: AnswerFailure };

const BY_PROBLEM: Readonly<Record<string, AnswerFailureKind>> = {
  'github-owner-not-connected': 'not-connected',
  'github-owner-mismatch': 'owner-mismatch',
  'github-app-not-installed': 'app-not-installed',
  'issue-closed': 'issue-closed',
  'answer-in-progress': 'in-progress',
  'answer-not-waiting': 'not-waiting',
  'answer-not-allowed': 'not-allowed',
  'answer-needs-reason': 'needs-reason',
  'github-rate-limit': 'rate-limited',
};

const RECOVERY: Readonly<Record<AnswerFailureKind, AnswerRecovery>> = {
  'not-connected': 'settings',
  'owner-mismatch': 'settings',
  'app-not-installed': 'settings',
  'issue-closed': 'refresh',
  'in-progress': 'retry',
  'not-waiting': 'refresh',
  'not-allowed': 'refresh',
  'needs-reason': 'none',
  'rate-limited': 'retry',
  offline: 'retry',
  unknown: 'retry',
};

function retryAfterOf(error: HttpErrorResponse): number | null {
  const header = error.headers?.get('Retry-After') ?? null;
  if (header === null || !/^\d{1,5}$/.test(header.trim())) {
    return null;
  }
  return Number(header.trim());
}

/**
 * The failure behind an error of the answer request. Branches on the problem `type` slug only (never on `title`
 * or `detail`); a network failure is `offline`, anything unknown is `unknown`. A repeat of either is safe: the
 * endpoint replays an answer it already wrote within 60 s instead of posting it again.
 */
export function answerFailureOf(error: unknown): AnswerFailure {
  let kind: AnswerFailureKind = 'unknown';
  let retryAfter: number | null = null;
  if (error instanceof HttpErrorResponse) {
    retryAfter = retryAfterOf(error);
    if (error.status === 0) {
      kind = 'offline';
    } else if (isProblemDetails(error.error)) {
      const slug = problemSlugOf(error.error.type);
      kind = (slug !== null ? BY_PROBLEM[slug] : undefined) ?? 'unknown';
    }
  }
  return { kind, recovery: RECOVERY[kind], retryAfter };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAnswerResponse(value: unknown): value is AnswerResponse {
  return (
    isRecord(value) &&
    typeof value['commentId'] === 'number' &&
    typeof value['url'] === 'string' &&
    typeof value['section'] === 'string' &&
    isAnswerCommand(value['command']) &&
    typeof value['replayed'] === 'boolean'
  );
}

/**
 * The request body for a tapped answer. The owner's words are the label of the button they tapped (in their
 * language), so a repeat of the same tap is byte-identical and the endpoint can replay it; the reason goes into
 * `text`. Nothing is concatenated into a command line here — the Worker composes the comment.
 */
export function answerRequestOf(command: AnswerCommand, ownerSaid: string, reason = ''): AnswerRequest {
  const text = reason.trim();
  if (NEEDS_REASON.has(command) && text === '') {
    throw new Error(`${command} needs a reason`);
  }
  if (text.length > ANSWER_TEXT_MAX_LENGTH || ownerSaid.length > ANSWER_TEXT_MAX_LENGTH) {
    throw new Error(`answer text is longer than ${ANSWER_TEXT_MAX_LENGTH} characters`);
  }
  return text === '' ? { command, ownerSaid } : { command, text, ownerSaid };
}

/** `POST /api/v1/projects/:slug/issues/:number/answer` (#10). Never throws: every outcome is an `AnswerResult`. */
@Injectable({ providedIn: 'root' })
export class AnswerClient {
  private readonly http = inject(HttpClient);

  async submit(slug: string, number: number, request: AnswerRequest): Promise<AnswerResult> {
    let response: HttpResponse<unknown>;
    try {
      response = await firstValueFrom(
        this.http.post<unknown>(answerUrl(slug, number), request, { observe: 'response' }),
      );
    } catch (error: unknown) {
      return { ok: false, failure: answerFailureOf(error) };
    }
    const body = response.body;
    if (!isAnswerResponse(body)) {
      // A 2xx we cannot read may still be a written comment; a retry is answered from the replay window.
      return { ok: false, failure: answerFailureOf(null) };
    }
    const replayed = body.replayed || response.headers.get('Idempotent-Replayed') === 'true';
    return { ok: true, response: { ...body, replayed } };
  }
}
