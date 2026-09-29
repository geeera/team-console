import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { problemTypeOf, type ProblemDetails } from '@shared/contracts';

export interface ProblemInit {
  /** Stable slug, e.g. `not-found`; becomes `https://team-console/problems/<slug>`. */
  readonly type: string;
  readonly title: string;
  readonly status: ContentfulStatusCode;
  readonly detail?: string;
  /** Seconds; sets `Retry-After` (rate limits, decision 19). */
  readonly retryAfter?: number;
  /**
   * RFC 9457 extension members, e.g. `connectUrl` (ADR 0003 decision 4). They may not replace a standard member,
   * and they are client-facing: never a credential or an upstream body.
   */
  readonly extensions?: Readonly<Record<string, string | number | boolean>>;
}

const STANDARD_MEMBERS: ReadonlySet<string> = new Set(['type', 'title', 'status', 'detail', 'instance']);

interface HasRequestId {
  Variables: { requestId: string };
}

/** The one way a Worker answers an error (RFC 9457, ADR 0001 decision 19). */
export function problem<E extends HasRequestId>(c: Context<E>, init: ProblemInit): Response {
  for (const name of Object.keys(init.extensions ?? {})) {
    if (STANDARD_MEMBERS.has(name)) {
      throw new Error(`a problem extension may not replace the standard member "${name}"`);
    }
  }
  const body: ProblemDetails = {
    ...init.extensions,
    type: problemTypeOf(init.type),
    title: init.title,
    status: init.status,
    instance: c.get('requestId'),
    ...(init.detail === undefined ? {} : { detail: init.detail }),
  };
  const headers: Record<string, string> = {
    'Content-Type': 'application/problem+json; charset=utf-8',
    'Cache-Control': 'no-store',
  };
  if (init.retryAfter !== undefined) {
    if (!Number.isInteger(init.retryAfter) || init.retryAfter < 0) {
      throw new Error(`retryAfter must be a non-negative integer number of seconds: ${init.retryAfter}`);
    }
    headers['Retry-After'] = String(init.retryAfter);
  }
  return c.body(JSON.stringify(body), init.status, headers);
}
