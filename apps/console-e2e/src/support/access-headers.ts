import type { APIRequestContext, BrowserContext } from '@playwright/test';

/**
 * The Cloudflare Access service token for a run against a target behind Access (stage, #142).
 *
 * The two headers carry a credential, so they never go into `use.extraHTTPHeaders` (Playwright sends those on every
 * request, to every origin) and never into a trace: the browser gets them per request from a context route that adds
 * them only for the target's own origin, the `request` fixture per call the same way, and the config turns traces
 * and the HTML report off while they are set (`accessRunOptions`).
 */
export type AccessHeaders = Readonly<Record<'CF-Access-Client-Id' | 'CF-Access-Client-Secret', string>>;

type Env = Readonly<Record<string, string | undefined>>;

/** Both variables set and non-empty → the headers; anything else → `null` (no Access, a local or Docker target). */
export function accessHeadersFromEnv(env: Env): AccessHeaders | null {
  const id = env['CF_ACCESS_CLIENT_ID'];
  const secret = env['CF_ACCESS_CLIENT_SECRET'];
  if (id === undefined || id === '' || secret === undefined || secret === '') {
    return null;
  }
  return { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret };
}

/** `url` (absolute, or relative to `target`) is on `target`'s origin. Unparseable → no. */
export function isTargetOrigin(url: string, target: string): boolean {
  try {
    return new URL(url, target).origin === new URL(target).origin;
  } catch {
    return false;
  }
}

/**
 * What a run with the Access token set must not keep: traces record every request header (the token included) and
 * the HTML report embeds them. Without the token nothing changes.
 */
export function accessRunOptions(access: AccessHeaders | null): {
  readonly trace: 'off' | 'retain-on-failure';
  readonly htmlReport: boolean;
} {
  return access === null
    ? { trace: 'retain-on-failure', htmlReport: true }
    : { trace: 'off', htmlReport: false };
}

/**
 * Adds the Access headers to the browser's requests to `target`'s origin only.
 *
 * Not `route.continue({ headers })`/`route.fallback({ headers })`: the browser keeps header overrides on the
 * redirects a request follows, so a target response redirecting to another site would carry the token there. The
 * request is fetched here instead with no redirect followed, and its response handed to the browser as is — a 3xx
 * then makes the browser issue a new request, which comes through this route again and is judged by its own origin.
 *
 * Registered first, so a spec's own `context.route`/`page.route` runs before it: one that ends with
 * `route.fallback()` reaches it, one that ends with `route.continue()` sends its request without the token (Access
 * then refuses it — closed, never leaked).
 */
export async function routeAccessHeaders(
  context: BrowserContext,
  target: string,
  access: AccessHeaders,
): Promise<void> {
  await context.route('**/*', async (route, request) => {
    if (!isTargetOrigin(request.url(), target)) {
      await route.fallback();
      return;
    }
    const response = await route.fetch({ headers: { ...request.headers(), ...access }, maxRedirects: 0 });
    await route.fulfill({ response });
  });
}

const SENDING = new Set<string | symbol>(['fetch', 'get', 'post', 'put', 'patch', 'delete', 'head']);

type Send = (
  urlOrRequest: string | { url(): string },
  options?: { headers?: Record<string, string> },
) => unknown;

/**
 * An `APIRequestContext` that adds the Access headers to calls on `target`'s origin only, and follows no redirect on
 * those calls (Playwright keeps custom headers across a redirect, also to another origin) — a redirect is returned
 * as the 3xx response. Calls to any other origin go out unchanged.
 */
export function scopeAccessHeaders(
  request: APIRequestContext,
  target: string,
  access: AccessHeaders,
): APIRequestContext {
  return new Proxy(request, {
    get(subject, property) {
      const value: unknown = Reflect.get(subject, property, subject);
      if (typeof value !== 'function') {
        return value;
      }
      const method = value as Send;
      if (!SENDING.has(property)) {
        return method.bind(subject);
      }
      return (
        urlOrRequest: string | { url(): string },
        options: { headers?: Record<string, string> } = {},
      ) => {
        const url = typeof urlOrRequest === 'string' ? urlOrRequest : urlOrRequest.url();
        if (!isTargetOrigin(url, target)) {
          return method.call(subject, urlOrRequest, options);
        }
        return method.call(subject, urlOrRequest, {
          ...options,
          headers: { ...options.headers, ...access },
          maxRedirects: 0,
        });
      };
    },
  });
}
