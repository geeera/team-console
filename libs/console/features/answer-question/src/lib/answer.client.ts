import { HttpClient, HttpErrorResponse, HttpResponse } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { ItemsApi, type TrackerFailure, type TrackerFailureKind } from '@console/entities/item';
import { isAccessSessionExpired } from '@console/shared/api';
import {
  ANSWER_LOOKUP_MAX_MS,
  ANSWER_TEXT_MAX_LENGTH,
  type AnswerCommand,
  type AnswerLookupRequest,
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

/** The item re-read before a late repeat (#120). */
export function answerLookupUrl(slug: string, number: number): string {
  return `${answerUrl(slug, number)}/lookup`;
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
  | 'session-expired'
  | 'offline'
  | 'forbidden'
  | 'unknown';

/**
 * What the card offers next: the same request again, a fresh list, Settings (the GitHub connection) or the project's
 * setup page (the console app's installation, #366).
 */
export type AnswerRecovery = 'retry' | 'refresh' | 'settings' | 'project-setup' | 'none';

export interface AnswerFailure {
  readonly kind: AnswerFailureKind;
  readonly recovery: AnswerRecovery;
  /** `Retry-After` in seconds, when the server sent one. */
  readonly retryAfter: number | null;
}

export type AnswerResult =
  | { readonly ok: true; readonly response: AnswerResponse }
  | { readonly ok: false; readonly failure: AnswerFailure };

/** The item re-read: the answer already written (`null`: none, the item still waits for it), or why not read. */
export type LookupResult =
  | { readonly ok: true; readonly answer: AnswerResponse | null }
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

/**
 * A console-tracker decision's failure in the card's words. The problem slugs are read once, by `trackerFailureOf`
 * of `@console/entities/item` (#457): this maps only its kinds, so the two can never disagree about a slug.
 */
const BY_TRACKER_KIND: Readonly<Record<TrackerFailureKind, AnswerFailureKind>> = {
  conflict: 'not-waiting',
  gone: 'not-waiting',
  invalid: 'needs-reason',
  // A decision never moves a task into a sprint; read as any other refusal.
  frozen: 'unknown',
  forbidden: 'forbidden',
  network: 'offline',
  timeout: 'offline',
  'in-flight': 'in-progress',
  'not-found': 'issue-closed',
  'session-expired': 'session-expired',
  unknown: 'unknown',
};

export function decisionFailureOf(failure: TrackerFailure): AnswerFailure {
  const kind = BY_TRACKER_KIND[failure.kind];
  return { kind, recovery: RECOVERY[kind], retryAfter: failure.retryAfter };
}

const RECOVERY: Readonly<Record<AnswerFailureKind, AnswerRecovery>> = {
  'not-connected': 'settings',
  'owner-mismatch': 'settings',
  'app-not-installed': 'project-setup',
  'issue-closed': 'refresh',
  'in-progress': 'retry',
  'not-waiting': 'refresh',
  'not-allowed': 'refresh',
  'needs-reason': 'none',
  'rate-limited': 'retry',
  // Only a new login helps; the app root shows its sign-in instead of the card (#367).
  'session-expired': 'none',
  offline: 'retry',
  // Not the owner: nothing changed, and a repeat would not change that.
  forbidden: 'none',
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
 * or `detail`); an expired Access session is `session-expired`, a network failure `offline`, anything unknown
 * `unknown`. A repeat of either of the last two is safe: the endpoint replays an answer it already wrote within
 * 60 s instead of posting it again.
 */
export function answerFailureOf(error: unknown): AnswerFailure {
  let kind: AnswerFailureKind = 'unknown';
  let retryAfter: number | null = null;
  if (error instanceof HttpErrorResponse) {
    retryAfter = retryAfterOf(error);
    // Before the status-0 check: Access's redirect arrives as an opaque status 0 but the network works (#367).
    if (isAccessSessionExpired(error, error.error)) {
      kind = 'session-expired';
    } else if (error.status === 0) {
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

/** What a decision answers: the item's section and the open console ask it names (`null`: none is open). */
export interface DecisionTarget {
  readonly slug: string;
  readonly number: number;
  readonly section: AnswerResponse['section'];
  readonly askId: number | null;
}

/** `POST /api/v1/projects/:slug/issues/:number/answer` (#10). Never throws: every outcome is an `AnswerResult`. */
@Injectable({ providedIn: 'root' })
export class AnswerClient {
  private readonly http = inject(HttpClient);
  private readonly items = inject(ItemsApi);

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

  /**
   * A decision on a console-tracker item (#435): `{command, text, askId, via: 'web'}` with the caller's
   * `Idempotency-Key`, which a repeat sends again so the decision is recorded once (24 h on the server). The answer
   * reads like a GitHub answer to the card (`commentId` is the decision's id, no GitHub `url`).
   */
  async decide(
    target: DecisionTarget,
    request: AnswerRequest,
    idempotencyKey: string,
  ): Promise<AnswerResult> {
    const result = await this.items.decide(
      target.slug,
      target.number,
      {
        command: request.command,
        text: request.text ?? '',
        askId: target.askId,
        reversesCommentId: null,
        via: 'web',
      },
      idempotencyKey,
    );
    if (!result.ok) {
      return { ok: false, failure: decisionFailureOf(result.failure) };
    }
    return {
      ok: true,
      response: {
        commentId: result.value.id,
        url: '',
        section: target.section,
        command: request.command,
        replayed: result.replayed,
      },
    };
  }

  /**
   * `POST …/answer/lookup` (#120): re-reads the item before an answer first sent more than the replay window ago is
   * repeated. `answer` is the comment already written with exactly this request (`replayed: true`), `null` when the
   * item still waits for it. An item that no longer takes it fails as the answer would (`issue-closed`, `not-*`).
   */
  async lookup(
    slug: string,
    number: number,
    request: AnswerRequest,
    sentAgoMs: number,
  ): Promise<LookupResult> {
    const body: AnswerLookupRequest = {
      ...request,
      sentAgoMs: Math.min(Math.max(0, Math.round(sentAgoMs)), ANSWER_LOOKUP_MAX_MS),
    };
    let response: unknown;
    try {
      response = await firstValueFrom(this.http.post<unknown>(answerLookupUrl(slug, number), body));
    } catch (error: unknown) {
      return { ok: false, failure: answerFailureOf(error) };
    }
    if (!isRecord(response) || !(response['answer'] === null || isAnswerResponse(response['answer']))) {
      return { ok: false, failure: answerFailureOf(null) };
    }
    const answer = response['answer'];
    return { ok: true, answer: answer === null ? null : { ...answer, replayed: true } };
  }
}
