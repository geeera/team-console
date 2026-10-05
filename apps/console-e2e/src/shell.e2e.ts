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

const TEAM_STATUS = '/api/v1/projects/team-console/team/status';

/** The device-local UI state key (`PERSISTED_STATE_KEY` in `persisted-state.model.ts`). */
const PERSISTED_STATE_KEY = 'tc.state.v1';

/** Writes a project's saved last section directly into storage, as an older app version would have. */
async function setLastPath(page: Page, slug: string, lastPath: string): Promise<void> {
  await page.evaluate(
    ([key, slug, lastPath]) => {
      const raw = localStorage.getItem(key);
      const state = raw !== null ? JSON.parse(raw) : { version: 1, activeSlug: null, pinned: [], collapsed: false, projects: {} };
      const project = state.projects[slug] ?? { lastPath: '', scroll: {}, chatDraft: '' };
      state.projects[slug] = { ...project, lastPath };
      localStorage.setItem(key, JSON.stringify(state));
    },
    [PERSISTED_STATE_KEY, slug, lastPath] as const,
  );
}

async function lastPathOf(page: Page, slug: string): Promise<string | undefined> {
  return page.evaluate(
    ([key, slug]) => {
      const raw = localStorage.getItem(key);
      const state = raw !== null ? JSON.parse(raw) : null;
      return state?.projects[slug]?.lastPath;
    },
    [PERSISTED_STATE_KEY, slug] as const,
  );
}

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

  test('A → B → A restores the screen and its scroll position', async ({ page }) => {
    await page.goto('/p/team-console/questions');
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
  });

  // The chat tab is a placeholder until #17 ships (#203): every way to reach it lands on the default section.
  test('the chat tab is hidden; its deep link, its saved last section and the switcher all land on the default section', async ({
    page,
  }) => {
    await page.goto('/p/team-console/questions');
    await expect(page.getByRole('link', { name: ru('space.chat') })).toHaveCount(0);

    // A typed URL, an old bookmark or the `pm-reply` push: no error screen, no placeholder text box.
    await page.goto('/p/team-console/chat');
    await expect(page).toHaveURL(/\/p\/team-console\/questions$/);
    await expect(page.locator('li[data-number="72"]')).toBeVisible();
    await expect(page.getByTestId('chat-draft')).toHaveCount(0);

    // A `lastPath` of `chat` saved before #203: app start replaces it with the section actually shown
    // (the store debounces its write, hence the poll).
    await setLastPath(page, 'team-console', 'chat');
    await page.goto('/');
    await expect(page).toHaveURL(/\/p\/team-console\/questions$/);
    await expect.poll(() => lastPathOf(page, 'team-console')).toBe('questions');

    // The switcher reopening a saved `chat` section behaves the same way.
    await switchTo(page, 'private-product');
    await setLastPath(page, 'team-console', 'chat');
    await switchTo(page, 'team-console');
    await expect(page).toHaveURL(/\/p\/team-console\/questions$/);
    await expect.poll(() => lastPathOf(page, 'team-console')).toBe('questions');
  });

  test('shell screens send only bodiless GETs: projects, needs-you, the overview and the open space team status', async ({
    page,
  }) => {
    const sent: Request[] = [];
    const statusCodes: number[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api')) {
        sent.push(request);
      }
    });
    page.on('response', (response) => {
      if (new URL(response.url()).pathname === TEAM_STATUS) {
        statusCodes.push(response.status());
      }
    });
    for (const path of [
      '/overview',
      '/needs-you',
      '/p/team-console/chat',
      '/p/team-console/artifacts',
      '/p/nope/demo',
    ]) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
    }

    // A project space reads its team status for the paused banner and the Commands panel (#114); an unknown one does not.
    // All projects reads its one overview request (#27).
    const allowed = new Set([
      'GET /api/v1/projects',
      'GET /api/v1/needs-you',
      'GET /api/v1/overview',
      `GET ${TEAM_STATUS}`,
      // The Artifacts section reads its list (#19).
      'GET /api/v1/projects/team-console/artifacts',
      // `/chat` is a placeholder until #17 ships (#203): it redirects to Questions, which reads its own list.
      'GET /api/v1/projects/team-console/questions',
    ]);
    const seen = sent.map((request) => `${request.method()} ${new URL(request.url()).pathname}`);
    expect(
      seen.filter((call) => !allowed.has(call)),
      'requests outside the allow-list',
    ).toEqual([]);
    expect(seen).toContain('GET /api/v1/projects');
    expect(statusCodes, 'team status reads must reach the api and succeed').not.toEqual([]);
    expect(
      statusCodes.filter((code) => code !== 200),
      'team status answers other than 200',
    ).toEqual([]);
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
