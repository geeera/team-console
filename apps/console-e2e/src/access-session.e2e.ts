import type { Page, Route } from '@playwright/test';
import { expect, expectAccessible, test } from './support/fixtures';
import { ru } from './support/i18n';
import { underServiceWorker } from './support/service-worker';

/**
 * An expired Cloudflare Access session (#284). On a deployed environment Access sits in front of the Worker: every
 * `/api` call is redirected to the team's login page and, after the login, Access sends the browser to
 * `/cdn-cgi/access/authorized` on our origin to set its cookie. Locally there is no Access, so both are routed here.
 */

const CALLBACK_MARKER = 'access-callback-reached-network';
const ACCESS_LOGIN =
  'https://geeera.cloudflareaccess.com/cdn-cgi/access/login/team-console-dev.geeera.workers.dev';

/** What Access answers every API call with once its session cookie has expired. */
async function redirectApiToAccess(page: Page): Promise<void> {
  await page.route('**/api/**', (route: Route) =>
    route.fulfill({ status: 302, headers: { Location: ACCESS_LOGIN } }),
  );
}

test.describe('expired Access session', () => {
  test('says the session expired instead of a generic error, and signs in again on the same page', async ({
    page,
  }) => {
    await redirectApiToAccess(page);
    await page.goto('/overview?view=all');

    const state = page.getByRole('alert').filter({ hasText: ru('app.session.expiredTitle') });
    await expect(state).toBeVisible();
    await expect(page.getByText(ru('shell.loadFailed'))).toHaveCount(0);
    await expect(
      page.getByRole('heading', { level: 1, name: ru('app.session.expiredTitle') }),
    ).toBeAttached();
    await expectAccessible(page, 'the expired-session state');

    // The sign-in is a full-page navigation the service worker leaves to the network, so Access can answer it.
    const navigation = page.waitForRequest((request) => request.isNavigationRequest());
    await page.getByRole('button', { name: ru('app.session.signIn') }).click();
    const target = new URL((await navigation).url());
    expect(target.pathname).toBe('/overview');
    expect(target.searchParams.get('view')).toBe('all');
    expect(target.searchParams.has('ngsw-bypass')).toBe(true);

    // Still signed out here (the route above stands in for Access): the state again, and the marker is gone.
    await expect(state).toBeVisible();
    await expect.poll(() => new URL(page.url()).searchParams.has('ngsw-bypass')).toBe(false);
    expect(new URL(page.url()).searchParams.get('view')).toBe('all');
  });
});

test.describe('service worker and the Access callback', () => {
  // The suite blocks service workers (playwright.config.ts); this one is about what the worker does.
  test.use({ serviceWorkers: 'allow' });

  test('an Access redirect on the API shows the expired-session state, not a synthesised 504', async ({
    page,
    context,
  }) => {
    await underServiceWorker(page, '/overview');
    const apiStatuses: number[] = [];
    page.on('response', (response) => {
      if (new URL(response.url()).pathname.startsWith('/api/')) {
        apiStatuses.push(response.status());
      }
    });
    // context.route: the page's own requests and any the worker would make for it.
    let redirected = 0;
    await context.route('**/api/**', (route: Route) => {
      redirected += 1;
      return route.fulfill({ status: 302, headers: { Location: ACCESS_LOGIN } });
    });

    await page.reload();

    await expect(page.getByRole('alert').filter({ hasText: ru('app.session.expiredTitle') })).toBeVisible();
    expect(redirected).toBeGreaterThan(0);
    expect(apiStatuses, 'API answers the page saw').not.toContain(504);

    const navigation = page.waitForResponse((response) => response.request().isNavigationRequest());
    await page.getByRole('button', { name: ru('app.session.signIn') }).click();
    const response = await navigation;
    expect(new URL(response.url()).searchParams.has('ngsw-bypass')).toBe(true);
    expect(response.fromServiceWorker(), 'the sign-in navigation must reach the network').toBe(false);
  });

  test('leaves a /cdn-cgi/ navigation to the network instead of serving the app shell', async ({
    page,
    context,
  }) => {
    await underServiceWorker(page, '/overview');

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
