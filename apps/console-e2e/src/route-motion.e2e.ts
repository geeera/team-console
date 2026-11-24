import type { Page } from '@playwright/test';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { seed } from './support/stack';

/**
 * Route enter (#506): the page a navigation mounts fades and rises; the project space around the section does not
 * move with it (one route-level animation at a time), and reduced motion keeps only a short fade.
 */

const SECTION = 'tc-questions-section-page';

test.beforeAll(async ({ stack }) => {
  requireLocalStack(stack);
  await seed(stack, ['geeera/team-console']);
});

async function openQuestionsFromBoard(page: Page): Promise<void> {
  await page.goto('/p/team-console/board');
  await expect(page.locator('tc-board-section-page')).toBeVisible();
  const tabs = page.getByRole('navigation', { name: ru('space.sections') });
  await tabs.getByRole('link', { name: ru('space.questions') }).click();
  await expect(page.locator(SECTION)).toBeVisible();
}

const styleOf = (page: Page, selector: string) =>
  page.locator(selector).evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      name: style.animationName,
      duration: style.animationDuration,
      shift: style.getPropertyValue('--motion-shift'),
    };
  });

const settled = (page: Page) =>
  page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));

test('a section change fades and rises the new page; the space itself stays still', async ({ page }) => {
  await openQuestionsFromBoard(page);

  expect(await styleOf(page, SECTION)).toMatchObject({ name: 'm-enter', duration: '0.24s', shift: '8px' });
  expect((await styleOf(page, 'tc-project-space-page')).name).toBe('none');

  await settled(page);
  await expectAccessible(page, 'questions after the route enter');
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('a section change only fades: no shift, 120 ms', async ({ page }) => {
    await openQuestionsFromBoard(page);
    expect(await styleOf(page, SECTION)).toMatchObject({ name: 'm-enter', duration: '0.12s', shift: '0px' });
  });
});
