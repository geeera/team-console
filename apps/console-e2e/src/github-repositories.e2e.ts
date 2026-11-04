import type { Page } from '@playwright/test';
import {
  INSTALLATION_REPOSITORIES_URL,
  type InstallationRepositoriesDto,
  type InstallationRepositoryDto,
} from '@shared/contracts';
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

test('#278: private repositories from GitHub are marked, and the missing step links to GitHub and refreshes', async ({
  page,
}) => {
  await page.goto('/overview');
  for (const fullName of ['geeera/private-product', 'geeera/no-yml']) {
    await expect(row(page, fullName).locator('.repo__private')).toHaveText(ru('overview.repos.row.private'));
  }
  await expect(row(page, 'geeera/team-console').locator('.repo__private')).toHaveCount(0);

  const step = section(page).getByRole('region', { name: ru('overview.repos.missing.title') });
  await expect(step).toBeVisible();
  const link = step.getByRole('link', { name: new RegExp(ru('overview.repos.missing.action')) });
  await expect(link).toHaveAttribute('href', 'https://github.com/settings/installations/1001');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await expectAccessible(page, 'All projects with the missing-repository step');

  const refresh = step.getByRole('button', { name: ru('overview.repos.missing.refresh') });
  const fresh = page.waitForRequest(
    (sent) =>
      new URL(sent.url()).pathname === '/api/v1/github/installation/repositories' &&
      new URL(sent.url()).search === '?fresh=1',
  );
  await refresh.click();
  await fresh;
  await expect(refresh).toBeFocused();
  await expect(row(page, 'geeera/private-product')).toBeVisible();
});

/**
 * #374: long enough to overflow the text column at 1440 px too, so the check means the same on both widths, and
 * within GitHub's 100 characters with its suffix (the client drops a longer name as not a repository).
 */
const LONG_NAME = `a-really-long-repository-name-to-check-wrapping-${'x'.repeat(40)}`;
const LONG_ROWS: readonly InstallationRepositoryDto[] = [
  { fullName: `geeera/${LONG_NAME}-add`, private: true, registration: { state: 'none' } },
  {
    fullName: `geeera/${LONG_NAME}-project`,
    private: false,
    registration: { state: 'active', slug: 'long-project' },
  },
  {
    fullName: `geeera/${LONG_NAME}-archived`,
    private: false,
    registration: { state: 'archived', slug: 'long-archived' },
  },
];

for (const colorScheme of ['light', 'dark'] as const) {
  test(`#374: a long repository name ends in an ellipsis before Add, Project and Archived (${colorScheme})`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme });
    // The installation's list is stretched in the browser: the api's mock repositories stay as other specs expect.
    await page.route(`**${INSTALLATION_REPOSITORIES_URL}*`, async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as InstallationRepositoriesDto;
      await route.fulfill({
        response,
        json: { ...body, repositories: [...LONG_ROWS, ...body.repositories] },
      });
    });
    await page.goto('/overview');
    await expect(page.locator('html')).toHaveCSS('color-scheme', colorScheme);

    const cases = [
      { fullName: LONG_ROWS[0]?.fullName ?? '', trailing: 'repo-add' },
      { fullName: LONG_ROWS[1]?.fullName ?? '', trailing: 'repo-project' },
      { fullName: LONG_ROWS[2]?.fullName ?? '', trailing: 'repo-archived' },
    ];
    for (const { fullName, trailing } of cases) {
      const name = row(page, fullName).locator('.repo__name');
      const control = row(page, fullName).getByTestId(trailing);
      await expect(name).toBeVisible();
      await expect(control).toBeVisible();
      const nameBox = await name.boundingBox();
      const controlBox = await control.boundingBox();
      expect(nameBox, `${trailing}: name box`).not.toBeNull();
      expect(controlBox, `${trailing}: control box`).not.toBeNull();
      expect(
        (nameBox?.x ?? 0) + (nameBox?.width ?? 0),
        `${trailing}: the name ends left of the control`,
      ).toBeLessThanOrEqual(controlBox?.x ?? 0);
      // Cut inside its own box (the ellipsis applies), not merely clipped by the card.
      expect(
        await name.evaluate((element) => element.scrollWidth > element.clientWidth),
        `${trailing}: the name is truncated`,
      ).toBe(true);
      await expect(name).toHaveCSS('text-overflow', 'ellipsis');
    }
    // The Add button still names the whole repository.
    await expect(
      row(page, LONG_ROWS[0]?.fullName ?? '').getByRole('button', {
        name: ru('overview.repos.row.addAria', { repo: LONG_ROWS[0]?.fullName ?? '' }),
      }),
    ).toBeVisible();
    await expectAccessible(page, `All projects with long repository names (${colorScheme})`);
  });
}

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
