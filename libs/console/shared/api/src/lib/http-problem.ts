import { HttpErrorResponse } from '@angular/common/http';
import { isProblemDetails, problemSlugOf, type ProblemDetails } from '@shared/contracts';

/** A failed console API call as the screens branch on it: never the raw body, never `detail` text. */
export interface HttpProblem {
  /** HTTP status; 0 when no response arrived (offline, aborted, blocked). */
  readonly status: number;
  /** Our problem slug (`github-rate-limit`), or null when the body was not one of our problems. */
  readonly slug: string | null;
  readonly problem: ProblemDetails | null;
  /** The problem's extension members (`step`, `installUrl`, …), still untrusted: read them with type guards. */
  readonly extensions: Readonly<Record<string, unknown>>;
  /** Seconds from `Retry-After`, when the response carried a usable one. */
  readonly retryAfterSeconds: number | null;
}

const PROBLEM_MEMBERS = new Set(['type', 'title', 'status', 'detail', 'instance']);

function retryAfterOf(error: HttpErrorResponse): number | null {
  const header = error.headers?.get('Retry-After');
  if (header === null || header === undefined || header.trim() === '') {
    return null;
  }
  const seconds = Number(header);
  return Number.isInteger(seconds) && seconds >= 0 ? seconds : null;
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
