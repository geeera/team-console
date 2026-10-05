import type { Locator, Page } from '@playwright/test';
import type { NeedsYouDto, OverviewDto, SprintDto } from '@shared/contracts';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { apiClient, seed } from './support/stack';

/**
 * All projects (#27): one tile per active project from one request — team state, sprint and demo day, done / total
 * as the board counts it, what waits for the owner — a failing project confined to its tile, and a tile that opens
 * the project's board, by pointer and by keyboard.
 */

const OVERVIEW = '/api/v1/overview';

const tileOf = (page: Page, slug: string): Locator =>
  page.locator(`[data-testid="overview-row"][data-project="${slug}"]`);

async function openOverview(page: Page): Promise<void> {
  await page.goto('/overview');
  await expect(page.getByRole('heading', { level: 1, name: ru('overview.title') })).toBeVisible();
  await expect(page.getByTestId('overview-row')).toHaveCount(2);
}

test.describe('with two active projects', () => {
  test.beforeAll(async ({ stack }) => {
    requireLocalStack(stack);
    await seed(stack, ['geeera/team-console', 'geeera/private-product']);
  });

  test('one tile per project with its numbers from a single request; the tile opens the board', async ({
    page,
    request,
  }) => {
    const overviewCalls: string[] = [];
    page.on('request', (sent) => {
      if (new URL(sent.url()).pathname === OVERVIEW) {
        overviewCalls.push(sent.method());
      }
    });
    await openOverview(page);
    expect(overviewCalls).toEqual(['GET']);
    await expect(page.getByTestId('count')).toHaveText(ru('overview.count.few', { n: 2 }));

    // The numbers the board and Needs you show for the same repository.
    const sprint = (await (await request.get('/api/v1/projects/team-console/sprint')).json()) as SprintDto;
    const needsYou = (await (await request.get('/api/v1/needs-you')).json()) as NeedsYouDto;
    const waiting = needsYou.items.filter((item) => item.project.slug === 'team-console').length;
    expect(sprint.milestone, 'the fixture repository has a current sprint').not.toBeNull();

    const tc = tileOf(page, 'team-console');
    await expect(tc).toHaveAttribute('href', '/p/team-console/board');
    await expect(tc.getByTestId('team')).toHaveText(ru('overview.team.running'));
    await expect(tc.getByTestId('sprint')).toContainText(sprint.milestone?.title ?? '');
    await expect(tc.getByTestId('progress')).toHaveText(
      ru('overview.done', { done: sprint.shipped, total: sprint.planned }),
    );
    await expect(tc.getByTestId('needs-you')).toContainText(ru('shell.badge', { n: waiting }));

    // No sprint, nothing waiting and project.yml without reviewer_logins: a quiet project that needs setup.
    const pp = page.getByTestId('overview-quiet').locator('[data-project="private-product"]');
    await expect(pp.getByTestId('sprint')).toHaveText(ru('overview.noSprint'));
    await expect(pp.getByTestId('setup')).toHaveText(ru('overview.setup'));
    await expect(pp.getByTestId('needs-you')).toHaveCount(0);

    await expectAccessible(page, 'All projects');

    await tc.click();
    await expect(page).toHaveURL(/\/p\/team-console\/board$/);
    await expect(page.getByTestId('stats').or(page.getByTestId('no-sprint'))).toBeVisible();
  });

  test('the keyboard reaches a tile and Enter opens its board', async ({ page }) => {
    await openOverview(page);
    const target = tileOf(page, 'team-console');
    let reached = false;
    for (let step = 0; step < 30 && !reached; step += 1) {
      await page.keyboard.press('Tab');
      reached = await target.evaluate((el) => el === document.activeElement);
    }
    expect(reached, 'Tab reaches the team-console tile').toBe(true);
    await expect(target).toBeFocused();
    // The focus ring is drawn (Paper Desk focus token), not left to the browser default or hidden.
    await expect(target).not.toHaveCSS('outline-style', 'none');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/p\/team-console\/board$/);
  });

  test('a project that cannot be read shows why in its own tile; the other still loads', async ({ page }) => {
    // The Worker's per-project failure (#27 spec in apps/api) as the client receives it.
    await page.route(OVERVIEW, async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as OverviewDto;
      const projects = body.projects.map((project) =>
        project.slug === 'private-product'
          ? {
              kind: 'failed' as const,
              slug: project.slug,
              name: project.name,
              problem: {
                type: 'github-app-not-installed',
                title: 'The console app is not installed on this repository',
                status: 409,
              },
            }
          : project,
      );
      await route.fulfill({ response, json: { ...body, projects } });
    });
    await openOverview(page);

    await expect(tileOf(page, 'private-product').getByTestId('problem')).toHaveText(
      ru('overview.problem.lead', { reason: ru('overview.problem.github-app-not-installed') }),
    );
    await expect(tileOf(page, 'private-product')).toHaveAttribute('href', '/p/private-product/board');
    await expect(tileOf(page, 'team-console').getByTestId('team')).toHaveText(ru('overview.team.running'));
    await expectAccessible(page, 'All projects, a project failing');
  });
});

test.describe('with the team paused by the owner', () => {
  test.beforeAll(async ({ stack }) => {
    requireLocalStack(stack);
    await seed(stack, ['geeera/team-console', 'geeera/private-product']);
    // The fake GitHub serves the run log thread (#22), so the owner's pause lands on it as on GitHub.
    const seeded = await fetch(`${stack.fakeURL ?? ''}/_fake/issue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repo: 'geeera/team-console',
        number: 22,
        title: 'Team run log',
        author: 'geeera',
        labels: ['team:run-log'],
        repoOwner: { login: 'geeera', id: 100001 },
      }),
    });
    expect(seeded.ok, 'the fake GitHub takes the run log').toBe(true);
    const api = await apiClient(stack);
    try {
      const paused = await api.post('/api/v1/projects/team-console/team/pause', { data: { reason: 'e2e' } });
      expect(paused.status(), await paused.text()).toBe(201);
    } finally {
      await api.dispose();
    }
  });

  // The fake GitHub outlives `seed`: resume, so later specs of this worker find the team running again.
  test.afterAll(async ({ stack }) => {
    const api = await apiClient(stack);
    try {
      const resumed = await api.post('/api/v1/projects/team-console/team/resume', { data: {} });
      expect(resumed.status(), await resumed.text()).toBe(201);
    } finally {
      await api.dispose();
    }
  });

  for (const colorScheme of ['light', 'dark'] as const) {
    test(`shows the project paused (${colorScheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      await openOverview(page);
      await expect(tileOf(page, 'team-console').getByTestId('team')).toHaveText(ru('overview.team.paused'));
      await expect(page.locator('html')).toHaveCSS('color-scheme', colorScheme);
      await expectAccessible(page, `All projects, paused (${colorScheme})`);
    });
  }
});
