import type { Route } from '@playwright/test';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { apiClient, seed } from './support/stack';
import { createItem, createSprint, switchToConsoleTracker } from './support/tracker-seed';

/**
 * The board's folders for a console-tracker project (#557): Sprint 02 is the next sprint and empty, Sprint 03 is
 * later with one task, the backlog has two. Each folder loads on Show tasks, only once per visit, and fails alone.
 */

const SLUG = 'team-console';
let later = 0;
let backlog: number[] = [];

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
    later = await createItem(api, SLUG, { title: 'Later work', kind: 'bug', status: 'approved', sprint: 3 });
    backlog = [
      await createItem(api, SLUG, { title: 'Idea one', status: 'proposed', sprint: null }),
      await createItem(api, SLUG, { title: 'Idea two', status: 'proposed', sprint: null }),
    ];
  } finally {
    await api.dispose();
  }
});

const folder = (page: import('@playwright/test').Page, name: RegExp) =>
  page.locator('tc-board-folder').filter({ has: page.getByRole('heading', { level: 2, name }) });

test('folders start collapsed with their counts; Show and Hide keep the folder loaded', async ({ page }) => {
  const reads: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes(`/projects/${SLUG}/items?`)) {
      reads.push(request.url());
    }
  });
  await page.goto(`/p/${SLUG}/board`);
  await expect(page.getByTestId('open-count')).toHaveText('1 открытая');

  const next = folder(page, /Следующий спринт\s+Sprint 02/);
  const laterFolder = folder(page, /Позже\s+Sprint 03/);
  const backlogFolder = folder(page, /Бэклог\s+Задачи без спринта/);
  await expect(next.getByTestId('folder-open-count')).toHaveText('0 открытых');
  await expect(laterFolder.getByTestId('folder-open-count')).toHaveText('1 открытая');
  await expect(backlogFolder.getByTestId('folder-open-count')).toHaveText('2 открытые');
  const before = reads.length;

  const show = laterFolder.getByRole('button', { name: 'Показать задачи: Sprint 03' });
  await expect(show).toHaveAttribute('aria-expanded', 'false');
  await show.click();
  const row = laterFolder.locator(`[data-number="${String(later)}"]`);
  await expect(row).toContainText('Later work');
  await expect(row.getByTestId('kind')).toHaveText('Ошибка');
  await expect(row.getByRole('link')).toHaveAttribute('href', `/p/${SLUG}/t/${String(later)}`);
  const hide = laterFolder.getByRole('button', { name: 'Скрыть задачи: Sprint 03' });
  await expect(hide).toBeFocused();
  await expect(hide).toHaveAttribute('aria-expanded', 'true');
  expect(reads.length - before).toBe(1);

  await hide.click();
  await expect(row).toBeHidden();
  await show.click();
  await expect(row).toBeVisible();
  expect(reads.length - before).toBe(1);

  await next.getByRole('button', { name: /Показать задачи/ }).click();
  await expect(next.getByTestId('folder-empty')).toContainText('В Sprint 02 пока ничего нет');
  await backlogFolder.getByRole('button', { name: /Показать задачи/ }).click();
  for (const number of backlog) {
    await expect(backlogFolder.locator(`[data-number="${String(number)}"]`)).toBeVisible();
  }
  await expectAccessible(page, 'board with every folder open');
});

test('a folder that fails shows an alert with Try again, alone, and loads on Try again', async ({ page }) => {
  let failures = 1;
  await page.route(
    (url) => url.pathname === `/api/v1/projects/${SLUG}/items` && url.searchParams.get('sprint') === 'none',
    async (route: Route) => {
      if (failures > 0) {
        failures -= 1;
        await route.fulfill({ status: 503, contentType: 'application/problem+json', body: '{"status":503}' });
        return;
      }
      await route.continue();
    },
  );
  await page.goto(`/p/${SLUG}/board`);
  const backlogFolder = folder(page, /Бэклог/);
  await backlogFolder.getByRole('button', { name: /Показать задачи/ }).click();
  const alert = backlogFolder.getByRole('alert');
  await expect(alert).toContainText('Не удалось загрузить: Бэклог');

  const laterFolder = folder(page, /Sprint 03/);
  await laterFolder.getByRole('button', { name: /Показать задачи/ }).click();
  await expect(laterFolder.locator(`[data-number="${String(later)}"]`)).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Sprint 01' })).toBeVisible();
  await expectAccessible(page, 'board with a failed folder');

  await alert.getByRole('button', { name: 'Повторить' }).click();
  await expect(backlogFolder.locator(`[data-number="${String(backlog[0])}"]`)).toBeVisible();
  await expect(alert).toBeHidden();
});

test.describe('in English', () => {
  test.use({ locale: 'en-US' });

  test('every folder open has no serious axe violations', async ({ page }) => {
    await page.goto(`/p/${SLUG}/board`);
    for (const name of ['Sprint 02', 'Sprint 03', 'Backlog']) {
      await page.getByRole('button', { name: `Show tasks: ${name}` }).click();
    }
    await expect(folder(page, /Next sprint\s+Sprint 02/).getByTestId('folder-empty')).toContainText(
      'Move tasks here from the backlog',
    );
    await expect(folder(page, /Backlog/).locator(`[data-number="${String(backlog[1])}"]`)).toBeVisible();
    await expectAccessible(page, 'board with every folder open, in English');
  });
});
