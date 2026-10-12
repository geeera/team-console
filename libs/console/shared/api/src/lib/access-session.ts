import type { HttpResponseBase } from '@angular/common/http';

/** Problem slugs after which signing in again can help; `access-forbidden`/`-misconfigured` would just loop. */
const REAUTH_PROBLEM_TYPE = /\/(access-missing|access-unverified)$/;

/** The host family of every Cloudflare Access team login page (`<team>.cloudflareaccess.com`). */
const ACCESS_LOGIN_HOST = 'cloudflareaccess.com';

/**
 * The query parameter Angular's service worker leaves to the network (`ngsw-bypass`). The sign-in navigation carries
 * it: a worker-served app shell would never reach Access, so the login could not start (#284).
 */
export const RELOGIN_MARKER = 'ngsw-bypass';

/** A declared non-JSON body (Access's login page is text/html); no header at all is not evidence either way. */
function isDeclaredNonJson(contentType: string | null): boolean {
  if (contentType === null) {
    return false;
  }
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return mediaType !== 'application/json' && !mediaType.endsWith('+json');
}

function isAccessLoginUrl(url: string | null): boolean {
  if (url === null) {
    return false;
  }
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    // A relative or malformed URL is ours, not Access's.
    return false;
  }
  return hostname === ACCESS_LOGIN_HOST || hostname.endsWith(`.${ACCESS_LOGIN_HOST}`);
}

function problemTypeOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const type: unknown = (body as Record<string, unknown>)['type'];
  return typeof type === 'string' ? type : null;
}

/**
 * Does this answer to a JSON `/api` call mean the Access session is gone, so only a new login helps?
 *
 * - a redirect: our `/api` never redirects, Access does (`opaqueredirect` with `redirect: 'manual'`, or `redirected`);
 * - a response from `*.cloudflareaccess.com` (a followed redirect);
 * - 401 with a non-JSON body (Access's own login page), or our 401 `access-missing|access-unverified`;
 * - 403 only with our own `access-missing|access-unverified` — a non-JSON 403 is left alone here because a
 *   Cloudflare WAF or rate-limit page also answers 403 with HTML; without the Access login URL or redirect above,
 *   nothing tells that page apart from ours, and showing «Сессия истекла» for it would be misleading (#289);
 * - a 2xx non-JSON body: Access's login page after a same-origin redirect.
 *
 * Status 0 alone (offline, aborted), a 5xx and the worker's synthesised 504 are not: re-login cannot fix them.
 */
export function isAccessSessionExpired(response: HttpResponseBase, body: unknown): boolean {
  if (response.responseType === 'opaqueredirect' || response.redirected === true) {
    return true;
  }
  if (isAccessLoginUrl(response.url)) {
    return true;
  }
  if (response.status === 401) {
    if (isDeclaredNonJson(response.headers.get('Content-Type'))) {
      return true;
    }
    const type = problemTypeOf(body);
    return type !== null && REAUTH_PROBLEM_TYPE.test(type);
  }
  if (response.status === 403) {
    const type = problemTypeOf(body);
    return type !== null && REAUTH_PROBLEM_TYPE.test(type);
  }
  return response.status >= 200 && response.status < 300 && isDeclaredNonJson(response.headers.get('Content-Type'));
}

/** The current address with the marker that makes the service worker leave the navigation to the network. */
export function reloginUrlOf(href: string): string {
  const url = new URL(href);
  url.searchParams.set(RELOGIN_MARKER, '1');
  return url.href;
}

/** The address without the sign-in marker, or null when it carries none. */
export function withoutReloginMarker(href: string): string | null {
  const url = new URL(href);
  if (!url.searchParams.has(RELOGIN_MARKER)) {
    return null;
  }
  url.searchParams.delete(RELOGIN_MARKER);
  return url.href;
}

/**
 * Drops the sign-in marker from the address bar once Access has sent the browser back, before the router reads it.
 * Call before bootstrapping the app.
 */
export function stripReloginMarker(view: Pick<Window, 'location' | 'history'>): void {
  const clean = withoutReloginMarker(view.location.href);
  if (clean !== null) {
    view.history.replaceState(view.history.state, '', clean);
  }
}
