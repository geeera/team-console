import type { Locator, Page } from '@playwright/test';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { seed } from './support/stack';
import { meetsMinTap } from './support/tap-target';

/**
 * Needs you readable on the phone (#204): the recommendation in plain words, details without markup, one title on
 * the phone and a one-line push nudge, so the first card and the top of the second fit the 390 × 844 screen.
 */

const isPhone = (page: Page): boolean => (page.viewportSize()?.width ?? 0) < 520;
const item = (page: Page, issue: number): Locator => page.locator(`li[data-number="${issue}"]`);

test.beforeAll(async ({ stack }) => {
  requireLocalStack(stack);
  await seed(stack, ['geeera/team-console', 'geeera/private-product']);
});

test('the team recommendation reads as a sentence, not command syntax', async ({ page }) => {
  await page.goto('/needs-you');
  const recommendation = item(page, 72).getByTestId('recommendation');

  await expect(recommendation).toContainText(ru('questions.recommends'));
  // #276: the recommended answer as a verb; the option's own words are what approving leads to.
  await expect(recommendation).toContainText(ru('questions.recommend.approve'));
  await expect(item(page, 72).getByTestId('outcomes')).toContainText('Начинаем разработку по плану к демо 16 октября');
  for (const raw of ['/approve', 'рекомендую', '·']) {
    await expect(recommendation).not.toContainText(raw);
    await expect(item(page, 72).getByTestId('outcomes')).not.toContainText(raw);
  }
  // The buttons still carry the commands.
  await expect(item(page, 72).locator('[data-command="approve"]')).toHaveText(ru('answer.command.approve'));
  await expect(item(page, 72).locator('[data-command="reject"]')).toHaveText(ru('answer.command.reject'));
  // An item from outside the team: its HTML stays inert text.
  await expect(item(page, 90001).getByTestId('recommendation')).toContainText('<img src=x');
  await expect(item(page, 90001).locator('img')).toHaveCount(0);
  await expectAccessible(page, 'Needs you, plain recommendation');
});

test('details on project Questions show no markup, team markers or answer line', async ({ page }) => {
  await page.goto('/p/team-console/questions');
  const card = item(page, 72);
  await card.getByText(ru('questions.details')).click();
  const body = card.locator('.question__body');

  await expect(body).toBeVisible();
  await expect(body).toHaveText('Сегодня ты решил: инфраструктуру больше не трогаем.');
  for (const raw of ['**', '<!--', 'pt-ask', 'Your answer']) {
    await expect(body).not.toContainText(raw);
  }
  // Nothing but the answer line in the untrusted item's body: no empty disclosure.
  await expect(item(page, 90001).locator('details')).toHaveCount(0);
  await expectAccessible(page, 'Project questions, details open');
});

for (const screen of [
  { path: '/needs-you', title: 'needsYou.title', ready: (p: Page) => expect(item(p, 72)).toBeVisible() },
  {
    path: '/overview',
    title: 'overview.title',
    ready: (p: Page) => expect(p.getByTestId('overview-row')).toHaveCount(2),
  },
  {
    path: '/settings',
    title: 'settings.title',
    ready: (p: Page) => expect(p.getByTestId('push-section')).toBeVisible(),
  },
]) {
  test(`${screen.path}: one visible title on the phone, the h1 kept for assistive tech`, async ({ page }) => {
    await page.goto(screen.path);
    await screen.ready(page);
    const heading = page.getByRole('heading', { level: 1, name: ru(screen.title) });

    await expect(heading).toHaveCount(1);
    const box = await heading.boundingBox();
    if (isPhone(page)) {
      expect(box?.height ?? 0).toBeLessThanOrEqual(1);
    } else {
      expect(box?.height ?? 0).toBeGreaterThan(20);
    }
  });
}

test('the push nudge is one line and the first card fits above the fold with the second in view', async ({
  page,
}) => {
  test.skip(!isPhone(page), 'the fold check is for the 390 × 844 phone');
  await page.goto('/needs-you');
  await expect(item(page, 72)).toBeVisible();
  const nudge = page.getByTestId('push-nudge');
  await expect(nudge).toBeVisible();

  const nudgeBox = await nudge.boundingBox();
  // One 44 px tap target plus padding and border.
  expect(nudgeBox?.height ?? 0).toBeLessThanOrEqual(56);
  const action = nudge.getByTestId('push-nudge-enable').or(nudge.getByTestId('push-nudge-how'));
  for (const target of [action, nudge.getByTestId('push-nudge-later')]) {
    const box = await target.boundingBox();
    expect(meetsMinTap(box?.height)).toBe(true);
    expect(meetsMinTap(box?.width)).toBe(true);
  }
  await expect(nudge.getByTestId('push-nudge-later')).toHaveAccessibleName(ru('push.nudge.laterAria'));

  const viewport = page.viewportSize()?.height ?? 0;
  const cards = page.locator('li[data-number]');
  const firstButtons = await cards.nth(0).locator('[data-command]').last().boundingBox();
  const second = await cards.nth(1).boundingBox();
  expect((firstButtons?.y ?? Infinity) + (firstButtons?.height ?? 0)).toBeLessThanOrEqual(viewport);
  expect(second?.y ?? Infinity).toBeLessThan(viewport);

  await nudge.getByTestId('push-nudge-later').click();
  await expect(nudge).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: ru('needsYou.title') })).toBeFocused();
});
