import { expect, requireLocalStack, test } from './support/fixtures';
import { apiClient, seed } from './support/stack';
import { createItem, createSprint, switchToConsoleTracker } from './support/tracker-seed';

/**
 * Remembered board folders and the `?section=` deep link (#562): Sprint 02 is the next sprint, Sprint 03 is later,
 * the backlog has one task. Builds on #557's folders (board-folders.e2e.ts).
 */

const SLUG = 'team-console';

test.describe.configure({ mode: 'serial' });

/** A day `days` from today in Kyiv, where the plugin counts sprint days. */
function inDays(days: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date(Date.now() + days * 86_400_000));
}

test.beforeAll(async ({ stack }, testInfo) => {
  requireLocalStack(stack);
  await seed(stack, ['geeera/team-console']);
  await switchToConsoleTracker(testInfo.workerIndex, SLUG, 'TC');
  const api = await apiClient(stack);
  try {
    for (const days of [10, 24, 38]) {
      await createSprint(api, SLUG, inDays(days));
    }
    await createItem(api, SLUG, { title: 'Current work', status: 'in-progress', sprint: 1 });
    await createItem(api, SLUG, { title: 'Idea one', status: 'proposed', sprint: null });
  } finally {
    await api.dispose();
  }
});

const folder = (page: import('@playwright/test').Page, name: RegExp) =>
  page.locator('tc-board-folder').filter({ has: page.getByRole('heading', { level: 2, name }) });

test('remembers which folders were open and opens them again, by itself, on the next visit', async ({ page }) => {
  await page.goto(`/p/${SLUG}/board`);
  const laterFolder = folder(page, /Позже\s+Sprint 03/);
  await laterFolder.getByRole('button', { name: /Показать задачи/ }).click();
  await expect(laterFolder.getByRole('button', { name: /Скрыть задачи/ })).toHaveAttribute('aria-expanded', 'true');

  await page.reload();
  const laterAfterReload = folder(page, /Позже\s+Sprint 03/);
  await expect(laterAfterReload.getByRole('button', { name: /Скрыть задачи/ })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  const backlogFolder = folder(page, /Бэклог\s+Задачи без спринта/);
  await expect(backlogFolder.getByRole('button', { name: /Показать задачи/ })).toHaveAttribute(
    'aria-expanded',
    'false',
  );

  // Hiding it again is remembered too.
  await laterAfterReload.getByRole('button', { name: /Скрыть задачи/ }).click();
  await page.reload();
  await expect(folder(page, /Позже\s+Sprint 03/).getByRole('button', { name: /Показать задачи/ })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
});

test('`?section=backlog` opens, loads and focuses the backlog folder', async ({ page }) => {
  await page.goto(`/p/${SLUG}/board?section=backlog`);
  const backlogFolder = folder(page, /Бэклог\s+Задачи без спринта/);
  await expect(backlogFolder.getByRole('button', { name: /Скрыть задачи/ })).toHaveAttribute('aria-expanded', 'true');
  await expect(backlogFolder.getByRole('heading', { level: 2 })).toBeFocused();
  await expect(backlogFolder.locator('[data-testid="folder-empty"]')).toHaveCount(0);

  const nextFolder = folder(page, /Следующий спринт\s+Sprint 02/);
  await expect(nextFolder.getByRole('button', { name: /Показать задачи/ })).toHaveAttribute('aria-expanded', 'false');
});

test.describe('in English', () => {
  test.use({ locale: 'en-US' });

  test('`?section=next` opens and focuses the next-sprint folder', async ({ page }) => {
    await page.goto(`/p/${SLUG}/board?section=next`);
    const nextFolder = folder(page, /Next sprint\s+Sprint 02/);
    await expect(nextFolder.getByRole('button', { name: /Hide tasks/ })).toHaveAttribute('aria-expanded', 'true');
    await expect(nextFolder.getByRole('heading', { level: 2 })).toBeFocused();
  });
});
