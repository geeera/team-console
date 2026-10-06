import type { Page } from '@playwright/test';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { apiClient, seed } from './support/stack';

/**
 * #194 on the mock stack: All projects lists the repositories of the owner's installation (fixtures on installation
 * 1001: team-console registered, private-product and no-yml not), and Add runs #24's check in the kit Sheet.
 */
test.describe.configure({ mode: 'serial' });

const section = (page: Page) => page.getByTestId('github-repositories');
const row = (page: Page, fullName: string) => section(page).locator(`[data-repo="${fullName}"]`);
const sheet = (page: Page) => page.getByRole('dialog');
const isPhone = (page: Page): boolean => (page.viewportSize()?.width ?? 0) < 900;

async function projectSlugs(stack: Parameters<typeof seed>[0]): Promise<string[]> {
  const api = await apiClient(stack);
  try {
    const response = await api.get('/api/v1/projects');
    const body = (await response.json()) as { slug: string }[];
    return body.map((project) => project.slug).sort();
  } finally {
    await api.dispose();
  }
}

test.beforeEach(async ({ stack }) => {
  requireLocalStack(stack);
  await seed(stack, ['geeera/team-console']);
});

test('lists one registered and the unregistered repositories, each with its marker', async ({ page }) => {
  await page.goto('/overview');

  await expect(
    section(page).getByRole('heading', { level: 2, name: ru('overview.repos.title') }),
  ).toBeVisible();
  const project = row(page, 'geeera/team-console');
  await expect(
    project.getByRole('link', {
      name: ru('overview.repos.row.projectAria', { repo: 'geeera/team-console' }),
    }),
  ).toHaveAttribute('href', '/settings/projects/team-console');
  for (const fullName of ['geeera/no-yml', 'geeera/private-product']) {
    await expect(
      row(page, fullName).getByRole('button', { name: ru('overview.repos.row.addAria', { repo: fullName }) }),
    ).toBeVisible();
    await expect(row(page, fullName)).toContainText(ru('overview.repos.row.private'));
  }
  await expectAccessible(page, 'All projects with Available on GitHub');
});

test('Add without project.yml: step 3 Missing, nothing saved, the row says why', async ({ page, stack }) => {
  await page.goto('/overview');
  const add = row(page, 'geeera/no-yml').getByRole('button', {
    name: ru('overview.repos.row.addAria', { repo: 'geeera/no-yml' }),
  });
  await add.click();

  await expect(sheet(page)).toBeVisible();
  // The sheet opens on its title; the mock answers at once, so focus is already on the result heading below.
  await expect(sheet(page)).toHaveAccessibleName(ru('overview.repos.sheet.title', { repo: 'geeera/no-yml' }));
  const result = sheet(page).getByTestId('add-result');
  await expect(result).toContainText(ru('settings.add.refused.title'));
  await expect(result).toContainText(ru('settings.add.refused.body'));
  await expect(sheet(page).locator('[data-step="yml"] [data-testid="step-state"]')).toHaveText(
    ru('settings.step.missing'),
  );
  await expect(result.getByRole('heading')).toBeFocused();
  await expectAccessible(page, 'Add sheet, project.yml missing');

  await sheet(page).getByTestId('sheet-close').click();
  await expect(sheet(page)).toBeHidden();
  await expect(add).toBeFocused();
  await expect(row(page, 'geeera/no-yml').getByTestId('repo-not-added')).toContainText(
    ru('overview.repos.row.notAdded', { n: 3 }),
  );
  expect(await projectSlugs(stack)).toEqual(['team-console']);
});

test('a successful Add: Done, the row turns "Project" and the project is in the switcher', async ({
  page,
  stack,
}) => {
  await page.goto('/overview');
  await row(page, 'geeera/private-product')
    .getByRole('button', { name: ru('overview.repos.row.addAria', { repo: 'geeera/private-product' }) })
    .click();

  await expect(sheet(page).getByTestId('add-result')).toBeVisible();
  await expectAccessible(page, 'Add sheet, added');
  await sheet(page)
    .getByRole('button', { name: ru('overview.repos.sheet.done') })
    .click();
  await expect(sheet(page)).toBeHidden();

  const link = row(page, 'geeera/private-product').getByRole('link', {
    name: ru('overview.repos.row.projectAria', { repo: 'geeera/private-product' }),
  });
  await expect(link).toBeFocused();
  await expect(link).toHaveAttribute('href', '/settings/projects/private-product');
  expect(await projectSlugs(stack)).toEqual(['private-product', 'team-console']);

  // The tiles at the top of the same screen have it too, without a reload (#242).
  await expect(page.getByTestId('count')).toHaveText(ru('overview.count.few', { n: 2 }));
  await expect(page.locator('[data-testid="overview-row"][data-project="private-product"]')).toBeVisible();

  // The switcher has it without a reload.
  if (isPhone(page)) {
    await page.getByRole('button', { name: ru('shell.openSwitcher') }).click();
    await expect(page.getByRole('dialog').locator('tc-project-switcher')).toContainText(/private/i);
  } else {
    await expect(page.locator('tc-project-switcher')).toContainText(/private/i);
  }
});

test('the Add project entry point opens All projects at the GitHub section', async ({ page }) => {
  await page.goto('/needs-you');
  if (isPhone(page)) {
    await page.getByRole('button', { name: ru('shell.openSwitcher') }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: ru('shell.addProject') })
      .click();
  } else {
    await page.getByTestId('sidebar-add-project').locator('button').click();
  }
  await expect(page).toHaveURL(/\/overview$/);
  await expect(
    section(page).getByRole('heading', { level: 2, name: ru('overview.repos.title') }),
  ).toBeFocused();
});
