import { HttpErrorResponse } from '@angular/common/http';
import { httpProblemOf, isAccessSessionExpired } from '@console/shared/api';
import { TimeoutError } from 'rxjs';

/**
 * Why a tracker write was not applied, as the task screen explains it (#409 spec §2.1, `err.*` copy):
 * - `conflict` — the item moved on since it was read (412 `item-version`, 409 `item-changed`): the owner's text stays;
 * - `gone` — the decision no longer waits (409 `ask-not-open`, `decision-command`, `item-closed`);
 * - `invalid` — 422 with the field to fix;
 * - `forbidden` — not the owner (403): nothing changed, no retry;
 * - `network` — no answer arrived (offline, dropped); `timeout` — none within `TRACKER_WRITE_TIMEOUT_MS`: both retry
 *   with the same idempotency key, so the write is never applied twice;
 * - `in-flight` — the same key is still being written (409 `idempotency-in-flight`): retry shortly;
 * - `not-found` — the item or project is gone; `session-expired` — Access wants a new login (the app root takes over);
 * - `unknown` — anything else, retried like `network`.
 */
export type TrackerFailureKind =
  | 'conflict'
  | 'gone'
  | 'invalid'
  | 'forbidden'
  | 'network'
  | 'timeout'
  | 'in-flight'
  | 'not-found'
  | 'session-expired'
  | 'unknown';

export interface TrackerFailure {
  readonly kind: TrackerFailureKind;
  /** The body member a 422 names (`title`, `body`, …), when it named one. */
  readonly field: string | null;
  /** Seconds from `Retry-After`, when the server sent one. */
  readonly retryAfter: number | null;
}

/**
 * A failed write handed up to the screen, which shows it at the top (#409 §2.1): `retry` repeats exactly that write,
 * idempotency key included.
 */
export interface FailedWrite {
  readonly failure: TrackerFailure;
  readonly retry: () => Promise<void>;
}

/** A write that gets no answer in this long is reported as `timeout`; its retry reuses the key. */
export const TRACKER_WRITE_TIMEOUT_MS = 20_000;

const CONFLICTS: ReadonlySet<string> = new Set(['item-version', 'item-changed', 'item-version-required']);
const GONE: ReadonlySet<string> = new Set([
  'ask-not-open',
  'ask-imported',
  'decision-command',
  'item-closed',
]);
const NOT_FOUND: ReadonlySet<string> = new Set(['item-not-found', 'project-not-found', 'sprint-not-found']);

/** Whether a failure is worth the same request again (the idempotency key makes that safe). */
export function isRetryable(failure: TrackerFailure): boolean {
  return (
    failure.kind === 'network' ||
    failure.kind === 'timeout' ||
    failure.kind === 'in-flight' ||
    failure.kind === 'unknown'
  );
}

/** Branches on the status and the problem slug only, never on `title` or `detail`. */
export function trackerFailureOf(error: unknown): TrackerFailure {
  const none = { field: null, retryAfter: null };
  if (error instanceof TimeoutError) {
    return { kind: 'timeout', ...none };
  }
  if (!(error instanceof HttpErrorResponse)) {
    return { kind: 'unknown', ...none };
  }
  // Before the status-0 check: Access's redirect arrives as an opaque status 0 while the network works (#367).
  if (isAccessSessionExpired(error, error.error)) {
    return { kind: 'session-expired', ...none };
  }
  const problem = httpProblemOf(error);
  const slug = problem.slug ?? '';
  const retryAfter = problem.retryAfterSeconds;
  const field = typeof problem.extensions['field'] === 'string' ? problem.extensions['field'] : null;
  if (problem.status === 0) {
    return { kind: 'network', field: null, retryAfter };
  }
  if (slug === 'idempotency-in-flight') {
    return { kind: 'in-flight', field: null, retryAfter };
  }
  if (problem.status === 412 || CONFLICTS.has(slug)) {
    return { kind: 'conflict', field: null, retryAfter };
  }
  if (GONE.has(slug)) {
    return { kind: 'gone', field: null, retryAfter };
  }
  if (problem.status === 403) {
    return { kind: 'forbidden', field: null, retryAfter };
  }
  if (problem.status === 404 || NOT_FOUND.has(slug)) {
    return { kind: 'not-found', field: null, retryAfter };
  }
  if (problem.status === 422 || problem.status === 413) {
    return { kind: 'invalid', field, retryAfter };
  }
  return { kind: 'unknown', field: null, retryAfter };
}

/** A fresh `Idempotency-Key` for one intended write; a retry of that write sends the same one. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
