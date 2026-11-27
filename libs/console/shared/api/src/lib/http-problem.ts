import { HttpErrorResponse } from '@angular/common/http';
import { isProblemDetails, problemSlugOf, retryAfterSecondsOf, type ProblemDetails } from '@shared/contracts';

/** A failed console API call as the screens branch on it: never the raw body, never `detail` text. */
export interface HttpProblem {
  /** HTTP status; 0 when no response arrived (offline, aborted, blocked). */
  readonly status: number;
  /** Our problem slug (`github-rate-limit`), or null when the body was not one of our problems. */
  readonly slug: string | null;
  readonly problem: ProblemDetails | null;
  /** The problem's extension members (`step`, `installUrl`, …), still untrusted: read them with type guards. */
  readonly extensions: Readonly<Record<string, unknown>>;
  /** Seconds from `Retry-After` (delta or HTTP-date) bounded to 1..3600, or null when it carried no usable one. */
  readonly retryAfterSeconds: number | null;
}

const PROBLEM_MEMBERS = new Set(['type', 'title', 'status', 'detail', 'instance']);

function retryAfterOf(error: HttpErrorResponse): number | null {
  // `0` is "retry now" during a rate limit: callers fall back to their own default instead (#133). A huge value is
  // capped at an hour, so no timer overflows (#813).
  return retryAfterSecondsOf(error.headers?.get('Retry-After'), Date.now(), { retryNow: 'absent' });
}

/** Narrows anything an `HttpClient` call threw; a non-HTTP error is a programming error and is rethrown. */
export function httpProblemOf(error: unknown): HttpProblem {
  if (!(error instanceof HttpErrorResponse)) {
    throw error;
  }
  const body: unknown = error.error;
  if (!isProblemDetails(body)) {
    return {
      status: error.status,
      slug: null,
      problem: null,
      extensions: {},
      retryAfterSeconds: retryAfterOf(error),
    };
  }
  const extensions = Object.fromEntries(
    Object.entries(body as unknown as Record<string, unknown>).filter(([key]) => !PROBLEM_MEMBERS.has(key)),
  );
  return {
    status: error.status,
    slug: problemSlugOf(body.type),
    problem: body,
    extensions,
    retryAfterSeconds: retryAfterOf(error),
  };
}
