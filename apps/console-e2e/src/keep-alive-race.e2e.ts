import type { APIRequestContext } from '@playwright/test';
import { expect, requireLocalStack, test } from './support/fixtures';
import { apiClient } from './support/stack';

/**
 * #957 regression guard for the local stack itself. workerd closes a keep-alive connection idle for 5 s; a request
 * written to one about 4.99 s after a parallel burst lands on a socket the server just closed. Under `wrangler dev`
 * its ProxyWorker answered such a POST with a 500 «Error: Network connection lost.» the Worker never saw (#947: 10 of
 * 32 at a 4990 ms gap), the browser's own requests included. On Miniflare there is no proxy: the browser resends on
 * the fresh socket itself, and `apiClient` resends Node's «socket hang up» (`support/idle-reset.ts`).
 */

const BURST = 6;
const POSTS = 4;
const CYCLES = 3;
const IDLE_MS = 4_990;
// The #947 route: the runner's enrol, here with a code that enrols nothing, so the Worker's own answer is a 4xx.
const ENROL = '/api/v1/runner/enrol';
const BODY = JSON.stringify({ code: 'not-a-code' });

interface Outcome {
  readonly statuses: number[];
  readonly lost: string[];
}

test.describe('the local stack across the 5 s keep-alive edge', () => {
  test.beforeEach(({ stack }, testInfo) => {
    requireLocalStack(stack);
    // Timing, not layout: one project is enough, and the race does not care about the viewport.
    test.skip(testInfo.project.name !== 'desktop', 'the race is the same on every project');
    test.setTimeout(60_000);
  });

  // The failed enrolments fill the route's rate limit; a later spec on this worker must not inherit it.
  test.afterEach(async ({ stack }) => {
    await stack.reset();
  });

  test('a browser POST about 5 s after a burst reaches the Worker', async ({ page }) => {
    await page.goto('/');
    const outcome = await page.evaluate(
      async ({ burst, posts, cycles, idleMs, enrol, body }) => {
        const statuses: number[] = [];
        const lost: string[] = [];
        for (let cycle = 0; cycle < cycles; cycle++) {
          await Promise.all(
            Array.from({ length: burst }, async () =>
              (await fetch('/api/v1/healthz', { cache: 'no-store' })).text(),
            ),
          );
          await new Promise((done) => setTimeout(done, idleMs));
          await Promise.all(
            Array.from({ length: posts }, async () => {
              try {
                const answer = await fetch(enrol, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body,
                });
                const text = await answer.text();
                statuses.push(answer.status);
                if (answer.status >= 500) {
                  lost.push(`${answer.status} ${text.slice(0, 80)}`);
                }
              } catch (error: unknown) {
                lost.push(String(error));
              }
            }),
          );
        }
        return { statuses, lost };
      },
      { burst: BURST, posts: POSTS, cycles: CYCLES, idleMs: IDLE_MS, enrol: ENROL, body: BODY },
    );

    expectEveryPostAnsweredByTheWorker(outcome);
  });

  test('an API client POST about 5 s after a burst reaches the Worker', async ({ stack }) => {
    const statuses: number[] = [];
    const lost: string[] = [];
    for (let cycle = 0; cycle < CYCLES; cycle++) {
      // A fresh client per cycle, as `enrolAsRunner` does: its sockets are the burst's own.
      const api = await apiClient(stack);
      try {
        await Promise.all(
          Array.from({ length: BURST }, async () => (await api.get('/api/v1/healthz')).text()),
        );
        await new Promise((done) => setTimeout(done, IDLE_MS));
        await Promise.all(Array.from({ length: POSTS }, () => postEnrol(api, statuses, lost)));
      } finally {
        await api.dispose();
      }
    }

    expectEveryPostAnsweredByTheWorker({ statuses, lost });
  });
});

async function postEnrol(api: APIRequestContext, statuses: number[], lost: string[]): Promise<void> {
  try {
    const answer = await api.post(ENROL, { data: BODY, headers: { 'Content-Type': 'application/json' } });
    statuses.push(answer.status());
    if (answer.status() >= 500) {
      lost.push(`${answer.status()} ${(await answer.text()).slice(0, 80)}`);
    }
  } catch (error: unknown) {
    lost.push(error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error));
  }
}

function expectEveryPostAnsweredByTheWorker({ statuses, lost }: Outcome): void {
  expect(lost, 'POSTs that never got the Worker’s own answer').toEqual([]);
  expect(statuses).toHaveLength(POSTS * CYCLES);
  // An invalid code (422) or the enrol route's rate limit (429): both are the Worker's answer.
  for (const status of statuses) {
    expect([422, 429]).toContain(status);
  }
}
