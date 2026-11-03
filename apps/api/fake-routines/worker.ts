import { FakeRoutines, type FakeRoutineOutcome } from '@worker/routines/testing';

/**
 * Local only (`nx run api:fake-routines`, 127.0.0.1:9998): the fake routines API of `@worker/routines/testing` as a
 * Worker, so "Run now" (#114) runs end to end against `wrangler dev` of the api with
 * `--var ROUTINES_FAKE_ORIGIN:http://127.0.0.1:9998`, and nothing ever reaches api.anthropic.com. Controls:
 * POST /_fake/next {"outcomes": [...]} queues how the next fires end, GET /_fake/state lists the fires (no tokens).
 */

const OUTCOMES: ReadonlySet<string> = new Set<FakeRoutineOutcome>([
  'ok',
  'rate-limited',
  'rate-limited-no-header',
  'paused',
  'bad-request',
  'unauthorized',
  'not-found',
  'forbidden',
  'unavailable',
  'hang',
]);

const fake = new FakeRoutines();

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function isOutcomes(value: unknown): value is { outcomes: FakeRoutineOutcome[] } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const outcomes = (value as Record<string, unknown>)['outcomes'];
  return Array.isArray(outcomes) && outcomes.every((item) => typeof item === 'string' && OUTCOMES.has(item));
}

export default {
  fetch: async (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/_fake/state') {
      return json(200, { fires: fake.fires });
    }
    if (url.pathname === '/_fake/next' && request.method === 'POST') {
      const body: unknown = await request.json();
      if (!isOutcomes(body)) {
        return json(400, { message: 'outcomes must be a list of known outcomes' });
      }
      fake.next(...body.outcomes);
      return json(200, body);
    }
    return fake.handle(new Request(`https://api.anthropic.com${url.pathname}${url.search}`, request));
  },
} satisfies ExportedHandler;
