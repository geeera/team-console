import type { APIRequestContext, APIResponse } from '@playwright/test';

/**
 * `wrangler dev` answers on its port through a ProxyWorker that forwards to the Worker over a pool of keep-alive
 * connections. workerd's HTTP server closes a connection idle for 5 s (KJ's pipelineTimeout) while the client side
 * evicts one at 5 s too, so a request that picks a connection idle for 4.99 s lands on one the other end just closed.
 * That happens on both hops, and the client sees two faces of the one race (#947, reproduced with a 4990 ms gap after a
 * parallel burst: 8/12 POSTs lost, 0/32 at 4900 or 5000 ms):
 *
 * - proxy → Worker: the proxy retries GET and HEAD itself and answers anything else 500 «Error: Network connection
 *   lost.» (plus a miniflare stack line) without the Worker ever having seen the request (wrangler ProxyWorker.ts);
 * - client → proxy: Playwright's own reused socket is reset before the request is read («socket hang up»,
 *   «read ECONNRESET»); a browser resends such a request itself, Node's http client does not.
 *
 * Production has no such proxy, so a spec's API client sends such a request once more — what the proxy does for a
 * GET — after a short pause, long enough for the pool to evict the rest of that burst's expiring connections (an
 * immediate resend picks the next one of them).
 */

/** The log line wrangler writes for one such request; its own words say the dev server continues. */
export const DEV_PROXY_DROP_MARKER = 'Error inside ProxyWorker';

/** wrangler's own second retry waits this long too. */
export const RESEND_DELAY_MS = 250;

const LOST_CONNECTION_FIRST_LINE = /^Error: Network connection lost\.?$/;
const RESET_BEFORE_READ = /socket hang up|ECONNRESET/;

/** Only the proxy's own failure: a 500 whose body opens with workerd's text for the dropped upstream connection. */
export async function isDevProxyDrop(response: APIResponse): Promise<boolean> {
  if (response.status() !== 500) {
    return false;
  }
  const [firstLine = ''] = (await response.text()).trim().split('\n');
  return LOST_CONNECTION_FIRST_LINE.test(firstLine.trim());
}

/** The client's reused socket to the proxy reset before the proxy read the request. */
export function isDevProxyReset(error: unknown): boolean {
  return error instanceof Error && RESET_BEFORE_READ.test(error.message);
}

const SENDING_METHODS: ReadonlySet<string | symbol> = new Set(['delete', 'fetch', 'patch', 'post', 'put']);

type Sender = (...args: unknown[]) => Promise<APIResponse>;

/**
 * The same client, sending a request the dev proxy dropped once more. GET and HEAD pass through untouched (wrangler
 * retries those itself); an unrelated 5xx or error comes back as it is.
 */
export function retryingDevProxyDrops(api: APIRequestContext, delayMs: number = RESEND_DELAY_MS): APIRequestContext {
  return new Proxy(api, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') {
        return value;
      }
      if (!SENDING_METHODS.has(property)) {
        return value.bind(target);
      }
      const send = value as Sender;
      return async (...args: unknown[]): Promise<APIResponse> => {
        let first: APIResponse;
        try {
          first = await send.apply(target, args);
        } catch (error: unknown) {
          if (!isDevProxyReset(error)) {
            throw error;
          }
          await pause(delayMs);
          return send.apply(target, args);
        }
        if (!(await isDevProxyDrop(first))) {
          return first;
        }
        await pause(delayMs);
        return send.apply(target, args);
      };
    },
  });
}

/** The Fetch API's face of the same two drops: the proxy's 500, or Node's `fetch failed` whose cause is the reset. */
async function isDevProxyDropResponse(response: Response): Promise<boolean> {
  if (response.status !== 500) {
    return false;
  }
  const [firstLine = ''] = (await response.clone().text()).trim().split('\n');
  return LOST_CONNECTION_FIRST_LINE.test(firstLine.trim());
}

function isDevProxyFetchReset(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const cause = error.cause;
  return isDevProxyReset(error) || (cause instanceof Error && isDevProxyReset(cause)) || (hasCode(cause) && cause.code === 'ECONNRESET');
}

function hasCode(value: unknown): value is { code: unknown } {
  return typeof value === 'object' && value !== null && 'code' in value;
}

/**
 * `fetch` for the stack's own servers (the fake GitHub's `/_fake/*` seeding, also a `wrangler dev`): sends a non-GET
 * request the dev proxy dropped once more, the same way as `retryingDevProxyDrops`.
 */
export async function fetchResendingDevProxyDrops(
  input: string | URL,
  init: RequestInit = {},
  delayMs: number = RESEND_DELAY_MS,
): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') {
    return fetch(input, init);
  }
  let first: Response;
  try {
    first = await fetch(input, init);
  } catch (error: unknown) {
    if (!isDevProxyFetchReset(error)) {
      throw error;
    }
    await pause(delayMs);
    return fetch(input, init);
  }
  if (!(await isDevProxyDropResponse(first))) {
    return first;
  }
  await pause(delayMs);
  return fetch(input, init);
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
