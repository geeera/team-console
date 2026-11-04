import type { Page, Route } from '@playwright/test';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { underServiceWorker } from './support/service-worker';
import { seed } from './support/stack';

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

test.describe('a sheet open when the session expires (#367)', () => {
  const REPO = 'geeera/team-console';
  // Neither «Нет связи» nor any «Нет сети…»: the network works, only the login is gone.
  const OFFLINE_WORDS = /Нет сети|Нет связи/;

  test.beforeEach(async ({ stack }) => {
    requireLocalStack(stack);
    // The Commands panel reads the run log: an owner-opened, running one, so Pause is on.
    const response = await fetch(`${stack.fakeURL ?? ''}/_fake/issue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repo: REPO,
        number: 22,
        title: 'Team run log',
        author: 'geeera',
        labels: ['team:run-log'],
        repoOwner: { login: 'geeera', id: 100001 },
      }),
    });
    expect(response.ok, await response.text()).toBe(true);
    await seed(stack, [REPO]);
  });

  /** The sign-in screen alone: no sheet left over it, focus on «Войти», nothing blaming the network. */
  async function expectSignInInFront(page: Page): Promise<void> {
    await expect(page.getByRole('alert').filter({ hasText: ru('app.session.expiredTitle') })).toBeVisible();
    await expect(page.locator('.cdk-overlay-container tc-sheet-container')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: ru('app.session.signIn') })).toBeFocused();
    await expect(page.getByText(OFFLINE_WORDS)).toHaveCount(0);
    await expect(
      page.getByRole('heading', { level: 1, name: ru('app.session.expiredTitle') }),
    ).toBeAttached();
    await expectAccessible(page, 'the expired-session state after a sheet was open');
  }

  test('Commands → Pause: an Access redirect on Confirm closes the sheets and shows the sign-in', async ({
    page,
  }) => {
    await page.goto('/p/team-console/questions');
    await page.getByTestId('commands-open').click();
    await expect(page.getByTestId('team-state')).toHaveText(ru('commands.status.running'));
    await page.getByTestId('team-command').click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toBeVisible();

    await redirectApiToAccess(page);
    await confirm.locator('.tc-confirm__ok').click();

    await expectSignInInFront(page);

    // After the sign-in the owner is back on the same page (#284).
    const navigation = page.waitForRequest((request) => request.isNavigationRequest());
    await page.getByRole('button', { name: ru('app.session.signIn') }).click();
    expect(new URL((await navigation).url()).pathname).toBe('/p/team-console/questions');
  });

  test('the design viewer: an Access redirect on its next call closes it and shows the sign-in', async ({
    page,
  }) => {
    await page.goto('/p/team-console/artifacts?type=design');
    const row = page.locator('[data-testid="artifact"][data-issue="90004"]');
    await row.getByRole('button').click();
    const viewer = page.locator('tc-sheet-container[role="dialog"]');
    await expect(viewer).toBeVisible();
    await expect(page.getByTestId('viewer-screen')).toBeVisible();

    await redirectApiToAccess(page);
    // «Интерактивно» asks the api for the project's embed origins.
    await page.locator('[data-testid="viewer-mode"][data-mode="interactive"]').click();

    await expectSignInInFront(page);
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
