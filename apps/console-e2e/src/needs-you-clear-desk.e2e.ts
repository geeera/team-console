import type { Page } from '@playwright/test';
import { expect, expectAccessible, test } from './support/fixtures';
import { ru } from './support/i18n';
import { seed } from './support/stack';

/**
 * The clear desk (#354): when nothing waits for the owner, Needs you is a sheet of paper with a green stamp «Всё
 * решено» and one serif line, not an empty text. The inbox is served empty on top of a seeded project. The stamp is
 * there when the page opens empty; under reduced motion it never strikes.
 */

const NEEDS_YOU = '**/api/v1/needs-you';

// A project must exist, or Needs you shows the «add a project» block instead of the inbox.
test.beforeAll(async ({ stack }) => {
  if (stack.isLocal) {
    await seed(stack, ['geeera/team-console']);
  }
});

async function serveEmptyInbox(page: Page): Promise<void> {
  await page.route(NEEDS_YOU, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [], projects: [], omittedProjects: [] }),
    }),
  );
}

test('an empty inbox is a clear desk with the stamp and the serif line', async ({ page }) => {
  await serveEmptyInbox(page);
  await page.goto('/needs-you');

  const desk = page.getByTestId('empty');
  await expect(desk.getByTestId('desk-stamp')).toHaveText(ru('needsYou.clear.stamp'));
  await expect(desk).toContainText(ru('needsYou.clear.title'));
  await expect(desk.getByTestId('desk-stamp')).toBeVisible();
  // The old empty copy is gone.
  await expect(page.getByText(ru('needsYou.emptyHint'))).toHaveCount(0);
  await expectAccessible(page, 'Needs you with a clear desk');
});

test('under reduced motion the stamp is simply there', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await serveEmptyInbox(page);
  await page.goto('/needs-you');

  const stamp = page.getByTestId('empty').getByTestId('desk-stamp');
  await expect(stamp).toBeVisible();
  await expect(stamp).toHaveCSS('animation-name', 'none');
  await expect(stamp).toHaveCSS('opacity', '1');
});
