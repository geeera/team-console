import type { Page } from '@playwright/test';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import {
  BUILD_MARKER,
  leaveAndReturn,
  openInstalled,
  routeDeploys,
  writeNextBuild,
  type Deploys,
} from './support/service-worker';

/**
 * A new deploy reaches an installed PWA that is never closed (#306). The page runs build A — the stack's build — under
 * Angular's real service worker; then the origin serves build B (new chunk names, a marked shell, its own ngsw.json),
 * as after `wrangler deploy`, and the app has to notice and switch without anyone clearing storage.
 */

const buildMarker = (page: Page) => page.locator(`meta[name="${BUILD_MARKER}"]`);

async function expectBuildB(page: Page): Promise<void> {
  await expect(buildMarker(page)).toHaveAttribute('content', 'B', { timeout: 20_000 });
}

test.describe('PWA updates', () => {
  test.use({ serviceWorkers: 'allow' });
  // Installing the worker waits for a stable app (up to 30 s) before a version can even be found.
  test.setTimeout(90_000);

  let deploys: Deploys;

  test.beforeEach(async ({ context, stack }, testInfo) => {
    requireLocalStack(stack);
    const nextBuild = writeNextBuild(`worker-${testInfo.workerIndex}`);
    deploys = await routeDeploys(context, new URL(stack.baseURL).origin, nextBuild);
  });

  test('a version found while a sheet is open waits in the banner, and «Обновить» switches the page to it', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'iphone', 'the project switcher sheet is the phone layout');
    await openInstalled(page, '/overview');
    await expect(buildMarker(page)).toHaveCount(0);

    await page.getByRole('button', { name: ru('shell.openSwitcher') }).click();
    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible();

    deploys.deployNext();
    await leaveAndReturn(page);

    // Under the open sheet the rest of the page is aria-hidden, so the banner is found by its test id here.
    await expect(page.getByTestId('update-banner')).toBeVisible({ timeout: 20_000 });
    await expect(buildMarker(page), 'nothing reloads under an open sheet').toHaveCount(0);

    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    const banner = page.getByRole('status').filter({ hasText: ru('app.update.ready') });
    await expect(banner).toBeVisible();
    await expectAccessible(page, 'the update banner');

    await banner.getByRole('button', { name: ru('app.update.apply') }).click();

    await expectBuildB(page);
    await expect(page.getByTestId('update-banner')).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe('/overview');
  });

  test('a version found on returning to a quiet app is taken at once, without the banner', async ({
    page,
  }) => {
    await openInstalled(page, '/overview');
    let bannerSeen = false;
    await page.exposeFunction('tcE2eBannerSeen', () => {
      bannerSeen = true;
    });
    await page.evaluate(() => {
      const report = (window as unknown as { tcE2eBannerSeen: () => void }).tcE2eBannerSeen;
      new MutationObserver(() => {
        if (document.querySelector('[data-testid="update-banner"]') !== null) {
          report();
        }
      }).observe(document.body, { childList: true, subtree: true });
    });

    deploys.deployNext();
    await leaveAndReturn(page);

    await expectBuildB(page);
    expect(bannerSeen, 'the banner never showed').toBe(false);
    expect(new URL(page.url()).pathname).toBe('/overview');
  });

  test('a broken worker heals itself: caches cleared, worker unregistered, one load past it', async ({
    page,
  }) => {
    await openInstalled(page, '/overview');
    // The installed version lost its lazy chunks (an evicted cache), and the server has moved on to build B, where
    // those files no longer exist: ngsw can neither serve nor re-fetch them and reports an unrecoverable state.
    const evicted = await page.evaluate(async () => {
      let count = 0;
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        for (const request of await cache.keys()) {
          if (/\/chunk-[^/]+\.js$/.test(new URL(request.url).pathname)) {
            await cache.delete(request);
            count += 1;
          }
        }
      }
      return count;
    });
    expect(evicted).toBeGreaterThan(0);
    deploys.deployNext();

    const healingLoad = page.waitForRequest(
      (request) => request.isNavigationRequest() && new URL(request.url()).searchParams.has('ngsw-bypass'),
    );
    // A screen whose code the page has not loaded yet.
    await page
      .getByRole('link', { name: ru('shell.settings') })
      .or(page.getByRole('button', { name: ru('shell.settings') }))
      .first()
      .click();

    await healingLoad;
    await expectBuildB(page);
    await expect.poll(() => new URL(page.url()).searchParams.has('ngsw-bypass')).toBe(false);
    expect(await page.evaluate(() => localStorage.getItem('tc.sw-recovery.v1'))).toMatch(/^\d+$/);
    // The old worker's caches went with it; whatever a fresh worker caches now is build B's.
    const oldChunks = await page.evaluate(async () => {
      const found: string[] = [];
      for (const name of await caches.keys()) {
        for (const request of await (await caches.open(name)).keys()) {
          const { pathname } = new URL(request.url);
          if (/^\/chunk-(?!next-)[^/]+\.js$/.test(pathname)) {
            found.push(`${name} ${pathname}`);
          }
        }
      }
      return found;
    });
    expect(oldChunks).toEqual([]);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });
});
