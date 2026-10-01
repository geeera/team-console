import { test as base, expect, type Page } from '@playwright/test';
import { LocalStack, portsFor } from '../stack/local-stack';
import { blockingViolations } from './axe';
import type { Stack } from './stack';

interface OutsideRequests {
  /** Lets the current test reach `origin` too (e.g. https://github.com, routed to the fake). */
  allow(origin: string): void;
}

interface WorkerFixtures {
  stack: Stack;
}

interface TestFixtures {
  outsideRequests: OutsideRequests;
  pageErrors: void;
}

function externalStack(baseURL: string): Stack {
  return {
    baseURL: baseURL.replace(/\/+$/, ''),
    fakeURL: process.env['FAKE_GITHUB_URL'] ?? null,
    isLocal: false,
    reset: () => Promise.reject(new Error('An external target (BASE_URL) cannot be reset')),
  };
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  stack: [
    // Playwright reads a fixture's dependencies from this destructuring; the stack depends on none.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use, workerInfo) => {
      const external = process.env['BASE_URL'];
      if (external !== undefined && external !== '') {
        await use(externalStack(external));
        return;
      }
      const local = await LocalStack.start(
        `worker-${workerInfo.parallelIndex}`,
        portsFor(workerInfo.parallelIndex),
      );
      try {
        await use({
          baseURL: local.baseURL,
          fakeURL: local.fakeURL,
          isLocal: true,
          reset: () => local.reset(),
        });
      } finally {
        await local.stop();
      }
    },
    { scope: 'worker', timeout: 180_000 },
  ],

  baseURL: async ({ stack }, use) => {
    await use(stack.baseURL);
  },

  // Every test: the app talks to its own origin only (no CDN, font, analytics or GitHub request from the page).
  outsideRequests: [
    async ({ context, stack }, use) => {
      const allowed = new Set([new URL(stack.baseURL).origin]);
      const outside: string[] = [];
      context.on('request', (request) => {
        const url = new URL(request.url());
        if ((url.protocol === 'http:' || url.protocol === 'https:') && !allowed.has(url.origin)) {
          outside.push(`${request.method()} ${url.origin}${url.pathname}`);
        }
      });
      await use({ allow: (origin) => allowed.add(origin) });
      expect(outside, 'requests that left the app origin').toEqual([]);
    },
    { auto: true },
  ],

  pageErrors: [
    async ({ context }, use) => {
      const errors: string[] = [];
      context.on('weberror', (error) => errors.push(error.error().message));
      await use();
      expect(errors, 'uncaught errors in the page').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** Fails the test on any serious or critical axe violation, listing them. */
export async function expectAccessible(page: Page, screen: string): Promise<void> {
  const violations = await blockingViolations(page);
  expect(violations, `serious/critical axe violations on ${screen}`).toEqual([]);
}

/** Local stacks only: specs that reset data or count comments on the fake GitHub. */
export function requireLocalStack(stack: Stack): void {
  test.skip(!stack.isLocal, 'needs the local stack (fresh database and the fake GitHub)');
}
