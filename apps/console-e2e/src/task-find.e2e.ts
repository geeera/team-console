import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { apiClient, seed } from './support/stack';
import { createItem, patchItem, switchToConsoleTracker } from './support/tracker-seed';

/**
 * Find a task (#435, #409 §2.4): by number (`142`, `#142`, `TC-142`), by a pasted GitHub issue link (numbers are
 * kept), by title words across open and closed tasks; "/" opens it on a Mac, ⌕ on the iPhone.
 */

const SLUG = 'team-console';
let open = 0;
let closed = 0;

test.beforeAll(async ({ stack }, testInfo) => {
  requireLocalStack(stack);
  await seed(stack, ['geeera/team-console']);
  await switchToConsoleTracker(testInfo.workerIndex, SLUG, 'TC');
  const api = await apiClient(stack);
  try {
    open = await createItem(api, SLUG, { title: 'Answer not saved on a slow network', kind: 'bug' });
    closed = await createItem(api, SLUG, { title: 'Slow network banner flickers', kind: 'bug' });
    await patchItem(api, SLUG, closed, { state: 'closed', closedReason: 'not-planned' });
  } finally {
    await api.dispose();
  }
});

test('opens from the space header and finds title words across open and closed tasks', async ({
  page,
}, testInfo) => {
  await page.goto(`/p/${SLUG}/questions`);
  await expect(page.getByTestId('find-open')).toBeVisible();
  if (testInfo.project.name === 'desktop') {
    await page.keyboard.press('/');
  } else {
    await page.getByRole('button', { name: ru('find.title') }).click();
  }
  const field = page.getByLabel(ru('find.label'));
  await expect(field).toBeFocused();
  await expect(page.getByRole('search')).toBeVisible();
  await field.fill('slow network');
  const results = page.getByTestId('find-results');
  await expect(results.getByRole('link')).toHaveCount(2);
  await expect(results.getByRole('link').nth(1)).toContainText(ru('find.closed'));
  await expect(page.getByTestId('find-status')).toHaveText('Найдено: 2');
  await expectAccessible(page, 'find with results');
  await results.getByRole('link').first().click();
  await expect(page).toHaveURL(new RegExp(`/p/${SLUG}/t/${String(open)}$`));
});

test('a number, a key or a pasted GitHub link finds the same task; Enter opens it', async ({ page }) => {
  for (const query of [
    String(open),
    `#${String(open)}`,
    `TC-${String(open)}`,
    `https://github.com/geeera/team-console/issues/${String(open)}`,
  ]) {
    await page.goto(`/p/${SLUG}/find?q=${encodeURIComponent(query)}`);
    await expect(page.getByTestId('find-results').getByRole('link')).toHaveText(
      new RegExp(`TC-${String(open)}`),
    );
  }
  const field = page.getByLabel(ru('find.label'));
  await field.fill(`TC-${String(closed)}`);
  await field.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/p/${SLUG}/t/${String(closed)}$`));
  await expect(page.getByTestId('task-closed')).toBeVisible();
});

test('says when nothing is found, and when a link is somewhere else', async ({ page }) => {
  await page.goto(`/p/${SLUG}/find`);
  const field = page.getByLabel(ru('find.label'));
  await field.fill('nothing like this');
  await expect(page.getByTestId('find-none')).toContainText(ru('find.none'));
  await field.fill('https://github.com/someone/else/issues/3');
  await expect(page.getByTestId('find-unknown')).toBeVisible();
  await expectAccessible(page, 'find none');
});
