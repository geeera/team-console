import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { apiClient, seed } from './support/stack';

/**
 * #792 on the mock stack: `geeera/mock-checks-not-accepted` sits on installation 1004, which has not accepted
 * Checks: read (an app created before #197). The api's read mint gets GitHub's 422, reads the installation's grants
 * and answers 409 `github-permission-not-accepted` with the installation settings page; the console says what to
 * accept where and links there instead of "GitHub didn't respond".
 */
const REPO = 'geeera/mock-checks-not-accepted';
const SETTINGS = 'https://github.com/settings/installations/1004';

test.beforeEach(async ({ stack }) => {
  requireLocalStack(stack);
  await seed(stack, ['geeera/team-console']);
});

test('Add by name on an installation without the new permission names it and links to the installation settings', async ({
  page,
  stack,
}) => {
  await page.goto('/overview');
  await expect(page.getByTestId('repos-registered')).toBeVisible();
  await page.getByTestId('by-name-toggle').click();
  await page.getByTestId('repo-field').fill(REPO);
  await page.getByTestId('add-submit').click();

  const result = page.getByTestId('add-result');
  await expect(result).toContainText(ru('settings.add.unavailable.permission'));
  await expect(result).not.toContainText(ru('settings.add.unavailable.github'));

  const link = result.getByRole('link', { name: new RegExp(ru('permissionNotAccepted.open')) });
  await expect(link).toHaveAttribute('href', SETTINGS);
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');

  await expectAccessible(page, 'add by name refused: new permissions not accepted');

  // Nothing was saved: the project list still holds the seeded project only.
  const api = await apiClient(stack);
  try {
    const projects = (await (await api.get('/api/v1/projects')).json()) as { slug: string }[];
    expect(projects.map((project) => project.slug)).toEqual(['team-console']);
  } finally {
    await api.dispose();
  }
});
