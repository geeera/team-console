import type { Page } from '@playwright/test';
import { expect, expectAccessible, test } from './support/fixtures';
import { ru } from './support/i18n';
import { seed } from './support/stack';

/**
 * The «Waiting for you» badge (#364) rolls to the new count after the owner answers and, at zero, shrinks into a dot
 * and leaves; under reduced motion it fades out. The sidebar is the wide layout, so the phone project is skipped. The
 * count is the one the shell polls; the test serves it and has the app refresh it the way a return to the tab does.
 */

const NEEDS_YOU = '**/api/v1/needs-you';

test.beforeAll(async ({ stack }) => {
  if (stack.isLocal) {
    await seed(stack, ['geeera/team-console']);
  }
});

test.skip(({ isMobile }) => isMobile, 'the sidebar badge is the wide layout');

async function serveWaiting(page: Page): Promise<(count: number) => void> {
  let count = 2;
  await page.route(NEEDS_YOU, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: Array.from({ length: count }, () => ({ project: { slug: 'team-console', name: 'team-console' } })),
      }),
    }),
  );
  return (next) => {
    count = next;
  };
}

async function refreshWaiting(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

test('the badge rolls down to the new count, then shrinks out at zero', async ({ page }) => {
  const setCount = await serveWaiting(page);
  await page.goto('/overview');
  const badge = page.locator('.shell__sidebar .shell__top tc-count-badge');
  await expect(badge.locator('.tc-sr-only')).toHaveText(ru('shell.badge', { n: 2 }));
  await expectAccessible(page, 'Sidebar with the waiting badge');

  setCount(1);
  await refreshWaiting(page);
  await expect(badge.locator('.tc-sr-only')).toHaveText(ru('shell.badge', { n: 1 }));

  setCount(0);
  await refreshWaiting(page);
  await expect(badge).toBeHidden();
  await expect(badge.locator('tc-chip')).toHaveCount(0);
});

test('under reduced motion the number changes at once and the badge fades out', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const setCount = await serveWaiting(page);
  await page.goto('/overview');
  const badge = page.locator('.shell__sidebar .shell__top tc-count-badge');
  await expect(badge.locator('.tc-sr-only')).toHaveText(ru('shell.badge', { n: 2 }));

  setCount(0);
  await refreshWaiting(page);
  await expect(badge).toBeHidden();
  await expect(badge.locator('.tc-roll__out')).toHaveCount(0);
});
