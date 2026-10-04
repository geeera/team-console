import { expect, expectAccessible, test } from './support/fixtures';
import { ru } from './support/i18n';

/**
 * Read-only checks that hold on any target — the local stack, the Docker image or stage (`BASE_URL`): they change
 * no data and need no particular project, so they are the part of the suite a live run can use.
 */

test('smoke: Settings opens with the GitHub card and the build stamp', async ({ page }) => {
  await page.goto('/settings');

  await expect(page.getByRole('heading', { level: 1, name: ru('settings.title') })).toBeVisible();
  // Whatever the target's GitHub state (connected, not, or not configured as in the bare Docker image), the card
  // finishes loading.
  await expect(page.getByRole('region', { name: ru('settings.gh.title') })).toBeVisible();
  await expect(page.getByTestId('gh-loading')).toBeHidden();
  await expect(page.getByTestId('app-built-at')).not.toBeEmpty();
  await expectAccessible(page, 'settings');
});

test('an unknown space shows "project not found" with a working way back', async ({ page }) => {
  await page.goto('/p/no-such-project/questions');

  await expect(page.getByRole('heading', { name: ru('notFound.projectTitle') })).toBeAttached();
  await expect(page.getByText(ru('notFound.projectHint', { slug: 'no-such-project' }))).toBeVisible();
  // The address stays as typed, so the owner sees what was wrong.
  await expect(page).toHaveURL(/\/p\/no-such-project\/questions$/);
  await expectAccessible(page, 'project not found');

  await page.getByTestId('not-found-back').click();
  await expect(page.getByTestId('not-found-back')).toBeHidden();
  await expect(page).not.toHaveURL(/no-such-project/);
});

test('an unknown route shows "no such page" with a working way back', async ({ page }) => {
  await page.goto('/no/such/page');

  await expect(page.getByRole('heading', { name: ru('notFound.routeTitle') })).toBeAttached();
  await page.getByTestId('not-found-back').click();
  await expect(page.getByTestId('not-found-back')).toBeHidden();
  await expect(page).not.toHaveURL(/no\/such\/page/);
});
