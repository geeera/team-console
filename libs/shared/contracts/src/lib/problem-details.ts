/**
 * RFC 9457 Problem Details as every Worker answers errors (ADR 0001, decision 19).
 * `type` is a stable URI built from a slug; the client matches on the slug, never on the host.
 */
export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  /** The request id, so a log line can be found from a screenshot. */
  readonly instance?: string;
}

export const PROBLEM_TYPE_PREFIX = 'https://team-console/problems/';

const SLUG = /^[a-z][a-z0-9-]*$/;

export function problemTypeOf(slug: string): string {
  if (!SLUG.test(slug)) {
    throw new Error(`Problem slug must match ${SLUG}: "${slug}"`);
  }
  return `${PROBLEM_TYPE_PREFIX}${slug}`;
}

/** The slug of a problem `type`, or null when it is not one of ours. */
export function problemSlugOf(type: string): string | null {
  if (!type.startsWith(PROBLEM_TYPE_PREFIX)) {
    return null;
  }
  const slug = type.slice(PROBLEM_TYPE_PREFIX.length);
  return SLUG.test(slug) ? slug : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Narrows an untrusted response body; the client never assumes an error payload's shape. */
export function isProblemDetails(value: unknown): value is ProblemDetails {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value['type'] === 'string' &&
    typeof value['title'] === 'string' &&
    Number.isInteger(value['status']) &&
    (value['detail'] === undefined || typeof value['detail'] === 'string') &&
    (value['instance'] === undefined || typeof value['instance'] === 'string')
  );
}
