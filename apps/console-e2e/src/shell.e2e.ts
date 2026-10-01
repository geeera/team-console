import type { Locator, Page, Request } from '@playwright/test';
import { expect, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { apiClient, archiveProject, seed } from './support/stack';

/** The spaces shell (#23, finding #96): switching projects keeps each one's place, unknown spaces say so. */

const isPhone = (page: Page): boolean => (page.viewportSize()?.width ?? 0) < 900;

/** A project's row in the switcher; its name may be followed by the Needs you badge. */
const projectRow = (scope: Locator, name: string): Locator =>
  scope.getByRole('button', { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`) });

/** The project switcher: the sidebar on a wide screen, the Projects sheet behind the top bar on the phone. */
async function switchTo(page: Page, name: string): Promise<void> {
  if (isPhone(page)) {
    await page.getByRole('button', { name: ru('shell.openSwitcher') }).click();
    await projectRow(page.getByRole('dialog'), name).click();
    await expect(page.getByRole('dialog')).toBeHidden();
  } else {
    await projectRow(page.getByRole('navigation', { name: ru('shell.nav') }), name).click();
  }
}

const main = (page: Page) => page.locator('main#tc-main');

test.describe('with two active projects', () => {
  test.beforeAll(async ({ stack }) => {
    requireLocalStack(stack);
    await seed(stack, ['geeera/team-console', 'geeera/private-product']);
  });

  test('Settings lists the projects and the connection', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByRole('heading', { level: 1, name: ru('settings.title') })).toBeVisible();
    await expect(page.getByTestId('gh-connected')).toContainText('geeera');
    const list = page.getByTestId('project-list');
    await expect(list.locator('[data-row]')).toHaveCount(2);
    await expect(list.locator('[data-row="team-console"]')).toBeVisible();
    await expect(list.locator('[data-row="private-product"]')).toBeVisible();
  });

  test('A → B → A restores the screen, its scroll position and the chat draft', async ({ page }) => {
    const draft = 'Черновик для PM: перенести демо?';
    await page.goto('/p/team-console/chat');
    await page.getByTestId('chat-draft').fill(draft);

    await page.getByRole('link', { name: ru('space.questions') }).click();
    await expect(page).toHaveURL(/\/p\/team-console\/questions$/);
    await expect(page.locator('li[data-number="72"]')).toBeVisible();
    const scrollable = await main(page).evaluate((el) => el.scrollHeight - el.clientHeight);
    expect(scrollable, 'the questions list must be long enough to scroll').toBeGreaterThan(300);
    await main(page).evaluate((el) => el.scrollTo({ top: 300 }));
    await expect.poll(() => main(page).evaluate((el) => el.scrollTop)).toBe(300);

    await switchTo(page, 'private-product');
    await expect(page).toHaveURL(/\/p\/private-product\//);
    await expect.poll(() => main(page).evaluate((el) => el.scrollTop)).toBe(0);

    await switchTo(page, 'team-console');
    await expect(page).toHaveURL(/\/p\/team-console\/questions$/);
    await expect(page.locator('li[data-number="72"]')).toBeVisible();
    await expect.poll(() => main(page).evaluate((el) => el.scrollTop)).toBe(300);

    await page.getByRole('link', { name: ru('space.chat') }).click();
    await expect(page.getByTestId('chat-draft')).toHaveValue(draft);
  });

  test('shell screens send only bodiless GET /api/v1/projects and /api/v1/needs-you', async ({ page }) => {
    const sent: Request[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api')) {
        sent.push(request);
      }
    });
    for (const path of [
      '/overview',
      '/needs-you',
      '/p/team-console/chat',
      '/p/team-console/board',
      '/p/nope/demo',
    ]) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
    }

    const allowed = new Set(['GET /api/v1/projects', 'GET /api/v1/needs-you']);
    const seen = sent.map((request) => `${request.method()} ${new URL(request.url()).pathname}`);
    expect(
      seen.filter((call) => !allowed.has(call)),
      'requests outside the allow-list',
    ).toEqual([]);
    expect(seen).toContain('GET /api/v1/projects');
    expect(
      sent.filter((request) => request.postDataBuffer() !== null || new URL(request.url()).search !== ''),
      'requests with a body or a query',
    ).toEqual([]);
  });
});

test.describe('with an archived project', () => {
  test.beforeAll(async ({ stack }) => {
    requireLocalStack(stack);
    await seed(stack, ['geeera/team-console', 'geeera/private-product']);
    const api = await apiClient(stack);
    try {
      await archiveProject(api, 'private-product');
    } finally {
      await api.dispose();
    }
  });

  test('its space shows "project not found" and the switcher no longer offers it', async ({ page }) => {
    await page.goto('/p/private-product/board');
    await expect(page.getByRole('heading', { name: ru('notFound.projectTitle') })).toBeAttached();
    await expect(page.getByText(ru('notFound.projectHint', { slug: 'private-product' }))).toBeVisible();

    await page.getByTestId('not-found-back').click();
    await expect(page).not.toHaveURL(/private-product/);
    if (isPhone(page)) {
      await page.getByRole('button', { name: ru('shell.openSwitcher') }).click();
    }
    const switcher = isPhone(page)
      ? page.getByRole('dialog')
      : page.getByRole('navigation', { name: ru('shell.nav') });
    await expect(projectRow(switcher, 'team-console')).toBeVisible();
    await expect(projectRow(switcher, 'private-product')).toHaveCount(0);
  });
});
