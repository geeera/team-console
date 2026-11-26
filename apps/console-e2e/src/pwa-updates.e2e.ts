import type { Page } from '@playwright/test';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { en, ru } from './support/i18n';
import { seed } from './support/stack';
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

  test('after the switch a paper note says «Обновлено до vX.Y» and leaves by itself (#347)', async ({
    page,
  }) => {
    await openInstalled(page, '/overview');
    await expect(page.getByTestId('updated-note'), 'no note on a plain start').toHaveCount(0);

    // Build B here stamps its own builtAt (writeNextBuild's default, #941), the way a real deploy's own
    // __TC_BUILT_AT__ always would even when the version string does not change.
    deploys.deployNext();
    await leaveAndReturn(page);
    await expectBuildB(page);

    const note = page.getByRole('status').filter({ hasText: /^\s*Обновлено до v\d/ });
    await expect(note).toBeVisible();
    await expectAccessible(page, 'the «Обновлено» note');
    await expect(page.getByTestId('updated-note')).toHaveCount(0, { timeout: 10_000 });

    await page.reload();
    await expect(page.getByTestId('updated-note'), 'the note shows once').toHaveCount(0);
  });

  test('after a same-build switch (same version, same builtAt) the page updates but shows no «Обновлено» note (#941)', async ({
    page,
  }, testInfo) => {
    await openInstalled(page, '/overview');
    await expect(page.getByTestId('updated-note'), 'no note on a plain start').toHaveCount(0);

    // A later route registration overrides the beforeEach one for matching requests (Playwright runs routes
    // last-registered-first): this swaps in a build that is byte-identical in build identity too (`sameBuild`),
    // the rare "nothing actually changed" deploy the note must stay quiet for (#941).
    const sameBuild = writeNextBuild(`worker-${testInfo.workerIndex}-same`, { sameBuild: true });
    const sameDeploys = await routeDeploys(page.context(), new URL(page.url()).origin, sameBuild);
    sameDeploys.deployNext();
    await leaveAndReturn(page);
    await expectBuildB(page);

    await expect(page.getByTestId('updated-note'), 'no note when the build did not change').toHaveCount(0);
    expect(
      await page.evaluate(() => localStorage.getItem('tc.updated-from.v1')),
      'the mark is consumed',
    ).toBeNull();
    await expectAccessible(page, 'the page after a same-build switch');

    await page.reload();
    await expect(page.getByTestId('updated-note'), 'still no note on a later reload').toHaveCount(0);
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

  for (const [locale, colorScheme] of [
    ['ru-RU', 'light'],
    ['en-US', 'dark'],
  ] as const) {
    test.describe(`a project space on the phone (${locale}, ${colorScheme})`, () => {
      test.use({ locale, colorScheme });

      // #368: the banner and the bottom tab bar stick to the same edge; the banner used to paint over the bar.
      test('the banner sits above the bottom tab bar and every section stays reachable', async ({
        page,
        stack,
      }, testInfo) => {
        test.skip(testInfo.project.name !== 'iphone', 'the bottom tab bar is the phone layout');
        await seed(stack, ['geeera/team-console']);
        await openInstalled(page, '/p/team-console/board');

        // An open sheet holds the switch back, which leaves the banner up (as in the first test).
        await page
          .getByRole('button', { name: (locale === 'ru-RU' ? ru : en)('shell.openSwitcher') })
          .click();
        await expect(page.getByRole('dialog')).toBeVisible();
        deploys.deployNext();
        await leaveAndReturn(page);
        await expect(page.getByTestId('update-banner')).toBeVisible({ timeout: 20_000 });
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).toBeHidden();

        const banner = page.getByTestId('update-banner');
        const bar = page.locator('nav.tc-tab-bar--bottom');
        const tabs = bar.getByRole('link');
        expect(await tabs.count()).toBeGreaterThan(1);

        for (let index = 0; index < (await tabs.count()); index += 1) {
          const tab = tabs.nth(index);
          const isTopmost = await tab.evaluate((element) => {
            const box = element.getBoundingClientRect();
            const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
            return hit !== null && element.contains(hit);
          });
          expect(isTopmost, `tab ${index} is covered`).toBe(true);
        }
        const bannerBox = await banner.boundingBox();
        const barBox = await bar.boundingBox();
        expect(bannerBox && barBox && bannerBox.y + bannerBox.height <= barBox.y + 0.5).toBe(true);
        await expect(
          banner.getByRole('button', { name: (locale === 'ru-RU' ? ru : en)('app.update.apply') }),
        ).toBeVisible();
        await expectAccessible(page, `the update banner above the tab bar (${locale}, ${colorScheme})`);
      });
    });
  }
});
