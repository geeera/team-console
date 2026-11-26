import type { Page } from '@playwright/test';
import { expect, expectAccessible, test } from './support/fixtures';
import { ru } from './support/i18n';
import { seed } from './support/stack';

/**
 * Counters roll (#351): when a refresh changes the number in the board's «Waiting for you» tile, the digit rolls to
 * the new value; under reduced motion it changes at once. The count is the one the shell polls, so the test serves it
 * and has the app refresh it the way a return to the tab does.
 */

const SLUG = 'team-console';
const NEEDS_YOU = '**/api/v1/needs-you';

const waitingItems = (count: number): { items: { project: { slug: string; name: string } }[] } => ({
  items: Array.from({ length: count }, () => ({ project: { slug: SLUG, name: SLUG } })),
});

test.beforeAll(async ({ stack }) => {
  if (stack.isLocal) {
    await seed(stack, ['geeera/team-console']);
  }
});

async function serveWaiting(page: Page): Promise<(count: number) => void> {
  let count = 3;
  await page.route(NEEDS_YOU, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(waitingItems(count)),
    }),
  );
  return (next) => {
    count = next;
  };
}

async function refreshWaiting(page: Page): Promise<void> {
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
}

test('the waiting tile rolls to the new count after a refresh', async ({ page }) => {
  const setCount = await serveWaiting(page);
  await page.goto(`/p/${SLUG}/board`);
  const tile = page.getByTestId('waiting-stat');
  await expect(tile.locator('dd')).toHaveText(ru('board.stat.waitingValue.few', { n: 3 }));
  await expect(tile.locator('.tc-roll__out')).toHaveCount(0);

  setCount(2);
  await refreshWaiting(page);

  await expect(tile.locator('dd')).toHaveText(ru('board.stat.waitingValue.few', { n: 2 }));
  await expect(tile.getByRole('button')).toHaveAccessibleName(
    new RegExp(ru('board.stat.waitingValue.few', { n: 2 })),
  );
  await expectAccessible(page, 'Board after a counter rolled');
});

test('under reduced motion the count changes at once, with no old value left on screen', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const setCount = await serveWaiting(page);
  await page.goto(`/p/${SLUG}/board`);
  const tile = page.getByTestId('waiting-stat');
  await expect(tile.locator('dd')).toHaveText(ru('board.stat.waitingValue.few', { n: 3 }));

  setCount(2);
  await refreshWaiting(page);

  await expect(tile.locator('dd')).toHaveText(ru('board.stat.waitingValue.few', { n: 2 }));
  await expect(tile.locator('.tc-roll__out')).toBeHidden();
});
