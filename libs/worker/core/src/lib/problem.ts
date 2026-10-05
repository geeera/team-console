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
   * RFC 9457 extension members (e.g. `step`, `connectUrl`), for clients that branch on more than the type.
   * They never carry request input or credentials; a standard member's name is refused.
   */
  readonly extensions?: Readonly<Record<string, ProblemExtensionValue>>;
}

/** A list is for enumerations the client renders (e.g. the commands an answer accepts), never for request input. */
export type ProblemExtensionValue = string | number | boolean | null | readonly string[];

const STANDARD_MEMBERS: ReadonlySet<string> = new Set(['type', 'title', 'status', 'detail', 'instance']);

interface HasRequestId {
  Variables: { requestId: string };
}

/** The one way a Worker answers an error (RFC 9457, ADR 0001 decision 19). */
export function problem<E extends HasRequestId>(c: Context<E>, init: ProblemInit): Response {
  const extensions = init.extensions ?? {};
  for (const name of Object.keys(extensions)) {
    if (STANDARD_MEMBERS.has(name)) {
      throw new Error(`a problem extension must not replace the standard member "${name}"`);
    }
  }
  const body: ProblemDetails & Readonly<Record<string, unknown>> = {
    type: problemTypeOf(init.type),
    title: init.title,
    status: init.status,
    instance: c.get('requestId'),
    ...(init.detail === undefined ? {} : { detail: init.detail }),
    ...extensions,
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
