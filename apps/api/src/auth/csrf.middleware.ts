import type { MiddlewareHandler } from 'hono';
import { problem, type WorkerHonoEnv } from '@worker/core';
import type { ApiEnv } from '../env';

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

function isJsonMediaType(contentType: string): boolean {
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType === 'application/json';
}

function hasBody(request: Request): boolean {
  return request.body !== null && request.headers.get('content-length') !== '0';
}

/**
 * Access injects a valid JWT for any request that carries its cookie — including a cross-site form POST from a
 * page the owner happens to open — so a verified token proves the browser, not the intent (threat model #8,
 * row 5). Writes must come from our own origin, and bodies must be JSON, which a cross-site form cannot send
 * without a CORS preflight; this Worker never answers a preflight with CORS headers.
 */
export const csrfMiddleware: MiddlewareHandler<WorkerHonoEnv<ApiEnv>> = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) {
    await next();
    return;
  }

  const fetchSite = c.req.header('Sec-Fetch-Site');
  const origin = c.req.header('Origin');
  // Browsers that send Sec-Fetch-Site are judged by it alone; older ones by an Origin equal to our own.
  const isSameOrigin =
    fetchSite !== undefined ? fetchSite === 'same-origin' : origin === new URL(c.req.url).origin;
  if (!isSameOrigin) {
    c.get('logger').warn('write rejected', { reason: 'csrf', method: c.req.method, path: c.req.path });
    return problem(c, { type: 'csrf', title: 'Forbidden', status: 403 });
  }

  const contentType = c.req.header('Content-Type');
  const isAcceptableBody = contentType === undefined ? !hasBody(c.req.raw) : isJsonMediaType(contentType);
  if (!isAcceptableBody) {
    return problem(c, {
      type: 'unsupported-media-type',
      title: 'Unsupported Media Type',
      status: 415,
      detail: 'Request bodies must be application/json.',
    });
  }

  await next();
  return;
};
