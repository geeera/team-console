import type { APIRequestContext, APIResponse } from '@playwright/test';

/**
 * `wrangler dev` answers on its port through a ProxyWorker that forwards to the Worker over a pool of keep-alive
 * connections. The Worker's HTTP server closes a connection idle for 5 s (KJ's pipelineTimeout) while the proxy's
 * pool evicts one at 5 s too, so a request that picks a connection idle for 4.99 s lands on one the Worker just
 * closed: the proxy retries GET and HEAD itself and answers anything else 500 «Error: Network connection lost.»
 * without the Worker ever having seen the request (wrangler ProxyWorker.ts; #947, reproduced at 10/32 POSTs with a
 * 4990 ms gap after a parallel burst, 0/32 at 4900 or 5000 ms). Production has no such proxy, so a spec's API
 * client sends such a request once more — the same thing the proxy does for a GET.
 */

/** The log line wrangler writes for one such request; its own words say the dev server continues. */
export const DEV_PROXY_DROP_MARKER = 'Error inside ProxyWorker';

const LOST_CONNECTION_BODY = /^Error: Network connection lost\.?$/;

/** Only the proxy's own failure: a 500 whose whole body is workerd's text for the dropped upstream connection. */
export async function isDevProxyDrop(response: APIResponse): Promise<boolean> {
  if (response.status() !== 500) {
    return false;
  }
  return LOST_CONNECTION_BODY.test((await response.text()).trim());
}

const SENDING_METHODS: ReadonlySet<string | symbol> = new Set(['delete', 'fetch', 'patch', 'post', 'put']);

type Sender = (...args: unknown[]) => Promise<APIResponse>;

/**
 * The same client, sending a request the dev proxy dropped once more. GET and HEAD pass through untouched (wrangler
 * retries those itself); an unrelated 5xx comes back as it is.
 */
export function retryingDevProxyDrops(api: APIRequestContext): APIRequestContext {
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
        const first = await send.apply(target, args);
        if (!(await isDevProxyDrop(first))) {
          return first;
        }
        return send.apply(target, args);
      };
    },
  });
}
