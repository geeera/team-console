import { HttpErrorResponse } from '@angular/common/http';
import { httpProblemOf, isAccessSessionExpired } from '@console/shared/api';
import { TimeoutError } from 'rxjs';

/**
 * Why an orchestration call did not succeed (#1042, routes of ADR 0010), branched on the status and the problem slug:
 * - `active` — 409 `orchestration-active`: a run is already on, so Start changed nothing;
 * - `idle` — 409 `orchestration-idle`: no run is on, so Stop changed nothing;
 * - `paused` — 409 `run-paused`: development is paused, Start is refused until it is resumed;
 * - `exists` — 409 `job-exists`: another orchestrator job (a slot started with Run now) holds the project's lock;
 * - `forbidden` — 403 (`owner-only`): Start and Stop are the account owner's;
 * - `not-found` — 404; `invalid` — 413/422; `rate-limited` — 429; `offline` — no answer; `timeout` — none in time;
 * - `session-expired` — Access wants a new login (the app root takes over); `error` — anything else, any other slug.
 */
export type OrchestrationFailureKind =
  | 'active'
  | 'idle'
  | 'paused'
  | 'exists'
  | 'forbidden'
  | 'not-found'
  | 'invalid'
  | 'rate-limited'
  | 'offline'
  | 'timeout'
  | 'session-expired'
  | 'error';

export interface OrchestrationFailure {
  readonly kind: OrchestrationFailureKind;
  /** Our problem slug, when the answer was one of our problems. */
  readonly slug: string | null;
}

export type OrchestrationResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: OrchestrationFailure };

/** A call with no answer in this long is reported as `timeout`. */
export const ORCHESTRATION_CALL_TIMEOUT_MS = 20_000;

const CONFLICTS: Readonly<Record<string, OrchestrationFailureKind>> = {
  'orchestration-active': 'active',
  'orchestration-idle': 'idle',
  'run-paused': 'paused',
  'job-exists': 'exists',
};

/** Never branches on `title` or `detail`: those are the Worker's English, not the owner's words. */
export function orchestrationFailureOf(error: unknown): OrchestrationFailure {
  if (error instanceof TimeoutError) {
    return { kind: 'timeout', slug: null };
  }
  if (!(error instanceof HttpErrorResponse)) {
    return { kind: 'error', slug: null };
  }
  // Before the status-0 check: Access's redirect arrives as an opaque status 0 while the network works (#367).
  if (isAccessSessionExpired(error, error.error)) {
    return { kind: 'session-expired', slug: null };
  }
  const problem = httpProblemOf(error);
  const failure = (kind: OrchestrationFailureKind): OrchestrationFailure => ({ kind, slug: problem.slug });
  switch (problem.status) {
    case 0:
      return failure('offline');
    case 403:
      return failure('forbidden');
    case 404:
      return failure('not-found');
    case 409:
      return failure((problem.slug === null ? undefined : CONFLICTS[problem.slug]) ?? 'error');
    case 413:
    case 422:
      return failure('invalid');
    case 429:
      return failure('rate-limited');
    default:
      return failure('error');
  }
}

const FAILURE_KEYS: Readonly<Record<OrchestrationFailureKind, string>> = {
  active: 'orchestration.err.active',
  idle: 'orchestration.err.idle',
  paused: 'orchestration.err.paused',
  exists: 'orchestration.err.exists',
  forbidden: 'orchestration.err.forbidden',
  'not-found': 'orchestration.err.notFound',
  invalid: 'orchestration.err.invalid',
  'rate-limited': 'orchestration.err.rateLimited',
  offline: 'orchestration.err.offline',
  timeout: 'orchestration.err.timeout',
  'session-expired': 'orchestration.err.sessionExpired',
  error: 'orchestration.err.error',
};

/** The `orchestration.err.*` key that words a failure: one table for Start, Stop and the state read. */
export function orchestrationFailureKeyOf(failure: OrchestrationFailure): string {
  return FAILURE_KEYS[failure.kind];
}
