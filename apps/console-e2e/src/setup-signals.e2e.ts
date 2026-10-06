import type { NeedsYouDto } from '@shared/contracts';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { seed } from './support/stack';
import { meetsMinTap } from './support/tap-target';

/**
 * Setup signals (#205). On the stack, team-console is set up except for webhook events (only a deployed hooks Worker
 * receives them), which needs nothing from the owner; private-product has no `team.reviewer_logins` and no routine
 * token, so it needs setup.
 */

test.beforeAll(async ({ stack }) => {
  requireLocalStack(stack);
  await seed(stack, ['geeera/team-console', 'geeera/private-product']);
});

test('a project that needs setup appears in Needs you with a working GitHub link; a ready one does not', async ({
  page,
  context,
  request,
  outsideRequests,
}) => {
  const needsYou = (await (await request.get('/api/v1/needs-you')).json()) as NeedsYouDto;
  const setupUrl = needsYou.projects.find((project) => project.slug === 'private-product')?.setupUrl;
  expect(setupUrl, 'private-product needs security setup on the stack').toMatch(/^https:\/\/github\.com\//);

  await page.goto('/needs-you');
  await expect(page.locator('li[data-number="72"]')).toBeVisible();

  const rows = page.getByRole('list', { name: ru('needsYou.attention.label') });
  const row = rows.getByRole('link', { name: ru('needsYou.attention.setup', { name: 'private-product' }) });
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('href', setupUrl ?? '');
  await expect(row).toHaveAttribute('target', '_blank');
  await expect(row).toHaveAccessibleName(
    `${ru('needsYou.attention.setup', { name: 'private-product' })} ${ru('push.arrive.external')}`,
  );
  await expect(page.locator('[data-testid="project-setup"][data-project="team-console"]')).toHaveCount(0);
  await expect(page.getByTestId('project-setup')).toHaveCount(1);

  // Above the cards, at least 44 px tall, and counted in the summary line.
  const rowBox = await row.boundingBox();
  const firstCard = await page.locator('.questions__list').boundingBox();
  expect(meetsMinTap(rowBox?.height)).toBe(true);
  expect((rowBox?.y ?? Infinity) < (firstCard?.y ?? 0)).toBe(true);
  const projectsNeedingYou = new Set([
    ...needsYou.items.map((item) => item.project.slug),
    ...needsYou.projects.filter((project) => project.setup || project.problem !== null).map((p) => p.slug),
  ]);
  expect(projectsNeedingYou.size).toBe(2);
  await expect(page.getByTestId('lead')).toHaveText(
    ru('needsYou.lead', { n: needsYou.items.length, k: projectsNeedingYou.size }),
  );

  await expectAccessible(page, 'needs you with a project that needs setup');

  // The link really opens the owner checklist on GitHub (answered here, so the run stays offline).
  outsideRequests.allow('https://github.com');
  await context.route(/^https:\/\/github\.com\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>checklist</title>' }),
  );
  const [opened] = await Promise.all([context.waitForEvent('page'), row.click()]);
  await expect(opened).toHaveURL(setupUrl ?? '');
  await opened.close();
});

test('a project waiting only for its first event is ready: no step left, a clock, no "How to fix"', async ({
  page,
}) => {
  await page.goto('/settings/projects/team-console');
  const events = page.locator('[data-step="events"]');
  await expect(events.getByTestId('step-state')).toHaveText(ru('settings.step.waiting'));

  await expect(page.getByTestId('setup-result').getByRole('heading', { level: 2 })).toHaveText(
    ru('settings.setup.readyWaiting.title'),
  );
  await expect(page.getByTestId('setup-result')).not.toContainText(
    ru('settings.add.saved.title.one', { n: 1 }),
  );
  await expect(events.locator('.step__mark')).toHaveAttribute('data-mark', 'clock');
  await expect(events.locator('.step__mark')).toHaveText('');
  await expect(events.getByRole('button', { name: ru('settings.step.how') })).toHaveCount(0);
  await expectAccessible(page, 'project setup waiting for the first event');
});
