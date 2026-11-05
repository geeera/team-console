import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { problem, type WorkerContext, type WorkerHonoEnv } from '@worker/core';
import type { ApiEnv } from '../env';
import { invalid } from './context';

type Context = WorkerContext<ApiEnv>;

/** ADR 0006: `limit ≤ 100`. */
export const PAGE_MAX = 100;
const PAGE_DEFAULT = 50;
const CURSOR = /^(0|[1-9][0-9]{0,15})$/;

/**
 * A request body cap above the text bounds (65,536 characters of up to four UTF-8 bytes, JSON escapes on top), so a
 * body within the bounds always fits and anything larger is refused before it is read: 413 `payload-too-large`.
 */
export function writeLimit(maxBytes: number): MiddlewareHandler<WorkerHonoEnv<ApiEnv>> {
  return bodyLimit({
    maxSize: maxBytes,
    onError: (c) =>
      problem(c as Context, { type: 'payload-too-large', title: 'Payload Too Large', status: 413 }),
  });
}

export const TEXT_WRITE_MAX_BYTES = 512 * 1024;
export const SMALL_WRITE_MAX_BYTES = 4 * 1024;
/**
 * Asks (2,048 characters), decision texts (2,000) and the PM's reasons (1,024): above `SMALL_WRITE_MAX_BYTES`, since
 * a Cyrillic or escaped text within its bound already outgrows 4 KB.
 */
export const ASK_WRITE_MAX_BYTES = 16 * 1024;

export interface Page {
  readonly after: number;
  readonly limit: number;
}

/** `?after=<cursor>&limit=<1..100>`, or the 400 `query-invalid` naming the parameter. */
export function pageOf(c: Context): Page | Response {
  const after = c.req.query('after') ?? '0';
  const limit = c.req.query('limit') ?? String(PAGE_DEFAULT);
  if (!CURSOR.test(after)) {
    return invalid(c, 'query-invalid', 'after', 'after is the cursor of the previous page');
  }
  const size = /^[1-9][0-9]{0,2}$/.test(limit) ? Number(limit) : 0;
  if (size < 1 || size > PAGE_MAX) {
    return invalid(c, 'query-invalid', 'limit', `limit is 1 to ${String(PAGE_MAX)}`);
  }
  return { after: Number(after), limit: size };
}

/** The next cursor of a page fetched with `limit + 1` rows: the last shown row's id when there is more. */
export function nextCursor<T extends { readonly id: number }>(
  rows: readonly T[],
  limit: number,
): number | null {
  return rows.length > limit ? (rows[limit - 1]?.id ?? null) : null;
}

/** `If-Match: "<version>"` as an item's `ETag` gives it; `null` when absent or not that shape. */
export function expectedVersionOf(c: Context): number | null {
  const match = /^"([1-9][0-9]{0,8})"$/.exec(c.req.header('If-Match') ?? '');
  return match === null ? null : Number(match[1]);
}

export function etagOf(version: number): string {
  return `"${String(version)}"`;
}
