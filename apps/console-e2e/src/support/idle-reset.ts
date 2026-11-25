import type { APIRequestContext, APIResponse } from '@playwright/test';

/**
 * workerd's HTTP server, which every local stack server answers on (Miniflare, `stack/serve-worker.mts`), closes a
 * keep-alive connection idle for 5 s (KJ's pipelineTimeout). Node's HTTP clients keep an idle socket about as long, so
 * a request that picks one idle for ~4.99 s is written to a socket the server just closed and fails with «socket hang
 * up» / «read ECONNRESET» (#947; #957 repro, a parallel GET burst then POSTs after 4990 ms: 16 of 32 lost through a
 * Playwright APIRequestContext, 0 at 4900, 5000 or 5010 ms). A browser resends such a request itself; Node's clients
 * do not. A target behind Cloudflare keeps connections open far longer, so only the local stack needs this.
 *
 * The resend is safe because workerd closes a connection only while it is idle, between two requests: the Worker never
 * read the request that failed, so sending it once more is its first delivery, a POST included. A reset with a request
 * in flight would also match, but only a workerd crash causes one, and a crash fails the test as a stack incident
 * (`LocalStack.incidents()`).
 */

/** Long enough for the client to evict the rest of that burst's expiring sockets; an immediate resend picks one. */
export const RESEND_DELAY_MS = 250;

const RESET_BEFORE_READ = /socket hang up|ECONNRESET/;

/**
 * The client's reused socket was closed under it before the server read the request: Playwright's own message, or
 * Node fetch's «fetch failed» whose cause is the reset.
 */
export function isIdleReset(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (RESET_BEFORE_READ.test(error.message)) {
    return true;
  }
  const cause: unknown = error.cause;
  return (
    (cause instanceof Error && RESET_BEFORE_READ.test(cause.message)) ||
    (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ECONNRESET')
  );
}

/** Sends once more, after `delayMs`, when the first send hit an idle reset; every other outcome is returned as it is. */
async function resendingOnIdleReset<T>(send: () => Promise<T>, delayMs: number): Promise<T> {
  try {
    return await send();
  } catch (error: unknown) {
    if (!isIdleReset(error)) {
      throw error;
    }
  }
  await new Promise<void>((done) => setTimeout(done, delayMs));
  return send();
}

/**
 * Every method of Playwright's `APIRequestContext` that sends a request; they share one signature and one failure, so
 * each is resent the same way whatever its HTTP method (`fetch` takes the method as an option, and the request itself
 * is not there to read before Playwright builds it). Named one by one rather than «every function»: `dispose` and
 * `storageState` send nothing, and running `dispose` twice would hide a real error behind «already disposed». The
 * spec compares this list with the client Playwright ships, so an upgrade that adds a method fails there (#982).
 */
export const SENDING_METHODS: ReadonlySet<string | symbol> = new Set([
  'delete',
  'fetch',
  'get',
  'head',
  'patch',
  'post',
  'put',
]);

type Sender = (...args: unknown[]) => Promise<APIResponse>;

/** The same client, sending a request once more when an idle reset failed it; every answer is returned as it is. */
export function resendingIdleResets(
  api: APIRequestContext,
  delayMs: number = RESEND_DELAY_MS,
): APIRequestContext {
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
      return (...args: unknown[]): Promise<APIResponse> =>
        resendingOnIdleReset(() => send.apply(target, args), delayMs);
    },
  });
}

/** `fetch` for the stack's own servers (the fake GitHub's `/_fake/*` seeding), with the same single resend. */
export function fetchResendingIdleResets(
  input: string | URL,
  init: RequestInit = {},
  delayMs: number = RESEND_DELAY_MS,
): Promise<Response> {
  return resendingOnIdleReset(() => fetch(input, init), delayMs);
}
