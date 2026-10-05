import type { WorkerContext } from '@worker/core';
import type { ApiEnv } from './env';

/** The JSON body, or `undefined` when there is none or it is not JSON (the route's parser then refuses it). */
export async function jsonBody(c: WorkerContext<ApiEnv>): Promise<unknown> {
  try {
    return (await c.req.json()) as unknown;
  } catch {
    // Malformed JSON is the client's input, answered as a validation problem; the parser's message is dropped.
    return undefined;
  }
}
