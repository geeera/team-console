import { HttpErrorResponse } from '@angular/common/http';
import { httpProblemOf, isAccessSessionExpired } from '@console/shared/api';
import { TimeoutError } from 'rxjs';

/**
 * Why a Settings › Runners call did not succeed, as the screens word it (#464):
 * - `forbidden` — 403: the caller is no owner of the account (`account-owner-only`) or this identity may not act;
 * - `not-found` — 404: the account, runner or project is not the caller's (the same answer as one that is missing);
 * - `invalid` — 422 with the problem slug (`allowed-projects-invalid`, `runner-policy-invalid`, …) and the field;
 * - `revoked` — 409 `runner-revoked`: someone revoked it meanwhile;
 * - `not-suspect` — 409 `runner-not-suspect`: its suspect mark was cleared meanwhile (#492);
 * - `rate-limited` — 429; `offline` — no answer; `timeout` — none in `RUNNER_CALL_TIMEOUT_MS`;
 * - `session-expired` — Access wants a new login (the app root takes over); `error` — anything else.
 */
export type RunnerFailureKind =
  | 'forbidden'
  | 'not-found'
  | 'invalid'
  | 'revoked'
  | 'not-suspect'
  | 'rate-limited'
  | 'offline'
  | 'timeout'
  | 'session-expired'
  | 'error';

export interface RunnerFailure {
  readonly kind: RunnerFailureKind;
  /** Our problem slug, when the answer was one of our problems. */
  readonly slug: string | null;
  /** The body member a 422 names. */
  readonly field: string | null;
}

export type RunnerResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: RunnerFailure };

/** A call with no answer in this long is reported as `timeout`. */
export const RUNNER_CALL_TIMEOUT_MS = 20_000;

/** Branches on the status and the problem slug only, never on `title` or `detail`. */
export function runnerFailureOf(error: unknown): RunnerFailure {
  if (error instanceof TimeoutError) {
    return { kind: 'timeout', slug: null, field: null };
  }
  if (!(error instanceof HttpErrorResponse)) {
    return { kind: 'error', slug: null, field: null };
  }
  // Before the status-0 check: Access's redirect arrives as an opaque status 0 while the network works (#367).
  if (isAccessSessionExpired(error, error.error)) {
    return { kind: 'session-expired', slug: null, field: null };
  }
  const problem = httpProblemOf(error);
  const field = typeof problem.extensions['field'] === 'string' ? problem.extensions['field'] : null;
  const failure = (kind: RunnerFailureKind): RunnerFailure => ({ kind, slug: problem.slug, field });
  switch (problem.status) {
    case 0:
      return failure('offline');
    case 403:
      return failure('forbidden');
    case 404:
      return failure('not-found');
    case 409:
      switch (problem.slug) {
        case 'runner-revoked':
          return failure('revoked');
        case 'runner-not-suspect':
          return failure('not-suspect');
        default:
          return failure('error');
      }
    case 413:
    case 422:
      return failure('invalid');
    case 429:
      return failure('rate-limited');
    default:
      return failure('error');
  }
}

/**
 * The `runners.err.*` key that explains a failure: one table for every Settings › Runners screen, so a refusal
 * reads the same in the list, the enrolment dialog and the policy editor.
 */
export function runnerFailureKeyOf(failure: RunnerFailure): string {
  if (failure.kind === 'invalid') {
    switch (failure.slug) {
      case 'allowed-projects-invalid':
        return 'runners.err.allowedProjects';
      case 'runner-policy-invalid':
        return failure.field === 'runner' ? 'runners.err.policyRunner' : 'runners.err.policy';
      default:
        return 'runners.err.invalid';
    }
  }
  if (failure.kind === 'not-found' && failure.slug === 'enrolment-not-found') {
    return 'runners.err.enrolmentGone';
  }
  return FAILURE_KEYS[failure.kind];
}

const FAILURE_KEYS: Readonly<Record<Exclude<RunnerFailureKind, 'invalid'>, string>> = {
  forbidden: 'runners.err.forbidden',
  'not-found': 'runners.err.notFound',
  revoked: 'runners.err.revoked',
  'not-suspect': 'runners.err.notSuspect',
  'rate-limited': 'runners.err.rateLimited',
  offline: 'runners.err.offline',
  timeout: 'runners.err.timeout',
  'session-expired': 'runners.err.sessionExpired',
  error: 'runners.err.error',
};
