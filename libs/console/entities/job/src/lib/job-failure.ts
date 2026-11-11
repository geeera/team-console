import { HttpErrorResponse } from '@angular/common/http';
import { httpProblemOf, isAccessSessionExpired } from '@console/shared/api';
import { TimeoutError } from 'rxjs';

/**
 * Why a jobs call did not succeed, as Run now and the job view word it (#464, routes of #467):
 * - `forbidden` — 403: Run now is the owner's (`owner-only`), or this identity may not read the project's jobs;
 * - `not-found` — 404: the project (or job) is not the caller's, the same answer as a missing one;
 * - `not-cut-over` — 409 `tracker-not-cut-over`: the project is still on GitHub Issues;
 * - `exists` — 409 `job-exists`: a job of this kind is already queued or running for the project;
 * - `invalid` — 413/422 (`job-invalid`): the request was refused as malformed;
 * - `rate-limited` — 429; `offline` — no answer; `timeout` — none in `JOB_CALL_TIMEOUT_MS`;
 * - `session-expired` — Access wants a new login (the app root takes over); `error` — anything else.
 */
export type JobFailureKind =
  | 'forbidden'
  | 'not-found'
  | 'not-cut-over'
  | 'exists'
  | 'invalid'
  | 'rate-limited'
  | 'offline'
  | 'timeout'
  | 'session-expired'
  | 'error';

export interface JobFailure {
  readonly kind: JobFailureKind;
  /** Our problem slug, when the answer was one of our problems. */
  readonly slug: string | null;
}

export type JobResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: JobFailure };

/** A call with no answer in this long is reported as `timeout`. */
export const JOB_CALL_TIMEOUT_MS = 20_000;

/** Branches on the status and the problem slug only, never on `title` or `detail`. */
export function jobFailureOf(error: unknown): JobFailure {
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
  const failure = (kind: JobFailureKind): JobFailure => ({ kind, slug: problem.slug });
  switch (problem.status) {
    case 0:
      return failure('offline');
    case 403:
      return failure('forbidden');
    case 404:
      return failure('not-found');
    case 409:
      return failure(
        problem.slug === 'job-exists'
          ? 'exists'
          : problem.slug === 'tracker-not-cut-over'
            ? 'not-cut-over'
            : 'error',
      );
    case 413:
    case 422:
      return failure('invalid');
    case 429:
      return failure('rate-limited');
    default:
      return failure('error');
  }
}

const FAILURE_KEYS: Readonly<Record<JobFailureKind, string>> = {
  forbidden: 'jobs.err.forbidden',
  'not-found': 'jobs.err.notFound',
  'not-cut-over': 'jobs.err.notCutOver',
  exists: 'jobs.err.exists',
  invalid: 'jobs.err.invalid',
  'rate-limited': 'jobs.err.rateLimited',
  offline: 'jobs.err.offline',
  timeout: 'jobs.err.timeout',
  'session-expired': 'jobs.err.sessionExpired',
  error: 'jobs.err.error',
};

/** The `jobs.err.*` key that explains a failure: one table for Run now and the job view. */
export function jobFailureKeyOf(failure: JobFailure): string {
  return FAILURE_KEYS[failure.kind];
}
