import { HttpErrorResponse } from '@angular/common/http';
import { httpProblemOf, isAccessSessionExpired } from '@console/shared/api';
import type { TrackerProblemType } from '@shared/contracts';
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

/**
 * The one table from a tracker problem slug to its kind (#457): the task screen's writes and the owner decisions of
 * `AnswerQuestion` and the batch dialog all read their failures through `trackerFailureOf`, so the slugs can never be
 * mapped two ways. Typed by the server's `TrackerProblemType`, so a renamed slug fails to compile here. A slug not
 * listed falls to its status (403, 404, 412, 422) below.
 */
const KIND_BY_PROBLEM: Partial<
  Readonly<Record<TrackerProblemType | 'project-not-found', TrackerFailureKind>>
> = {
  'item-version': 'conflict',
  'item-version-required': 'conflict',
  'item-changed': 'conflict',
  'ask-not-open': 'gone',
  'ask-imported': 'gone',
  'decision-command': 'gone',
  'item-closed': 'gone',
  'item-not-found': 'not-found',
  'project-not-found': 'not-found',
  'sprint-not-found': 'not-found',
  'idempotency-in-flight': 'in-flight',
};

const KINDS: ReadonlyMap<string, TrackerFailureKind | undefined> = new Map(Object.entries(KIND_BY_PROBLEM));

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
  const retryAfter = problem.retryAfterSeconds;
  const field = typeof problem.extensions['field'] === 'string' ? problem.extensions['field'] : null;
  if (problem.status === 0) {
    return { kind: 'network', field: null, retryAfter };
  }
  const listed = problem.slug === null ? undefined : KINDS.get(problem.slug);
  if (listed !== undefined) {
    // `decision-command` is the one `gone` problem that names a field (`command`, #470 item 3): kept here so the
    // screen can word it apart from `ask-not-open`/`ask-imported`/`item-closed`, which never do.
    return { kind: listed, field, retryAfter };
  }
  if (problem.status === 412) {
    return { kind: 'conflict', field: null, retryAfter };
  }
  if (problem.status === 403) {
    return { kind: 'forbidden', field: null, retryAfter };
  }
  if (problem.status === 404) {
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
