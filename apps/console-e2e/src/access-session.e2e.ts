import type { Route } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { ru } from './support/i18n';

/**
 * An expired Cloudflare Access session (#284). On a deployed environment Access sits in front of the Worker: every
 * `/api` call is redirected to the team's login page and, after the login, Access sends the browser to
 * `/cdn-cgi/access/authorized` on our origin to set its cookie. Locally there is no Access, so both are routed here.
 */

const CALLBACK_MARKER = 'access-callback-reached-network';

test.describe('service worker and the Access callback', () => {
  // The suite blocks service workers (playwright.config.ts); this one is about what the worker does.
  test.use({ serviceWorkers: 'allow' });

  test('leaves a /cdn-cgi/ navigation to the network instead of serving the app shell', async ({
    page,
    context,
  }) => {
    await page.goto('/overview');
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    // The worker claims the page once it activates; until then it would not see the navigation at all.
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

    // Cloudflare's edge answers /cdn-cgi/ on a deployed origin; context.route also sees the worker's own fetches.
    const callbacks: string[] = [];
    await context.route('**/cdn-cgi/**', (route: Route) => {
      callbacks.push(route.request().url());
      return route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html><html lang="en"><title>Access</title><main><p>${CALLBACK_MARKER}</p></main></html>`,
      });
    });

    await page.goto('/cdn-cgi/access/authorized?x=1');

    await expect(page.getByText(CALLBACK_MARKER)).toBeVisible();
    await expect(page.getByText(ru('notFound.routeTitle'))).toHaveCount(0);
    expect(callbacks.map((url) => new URL(url).pathname)).toContain('/cdn-cgi/access/authorized');
  });
});
