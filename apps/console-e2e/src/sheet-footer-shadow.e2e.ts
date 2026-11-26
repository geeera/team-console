import type { Locator, Page } from '@playwright/test';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { seed } from './support/stack';
import { switchToConsoleTracker } from './support/tracker-seed';

/**
 * The pinned action bar's shadow (#352): in a dialog taller than the screen the bar casts a soft paper shadow while
 * text is hidden under it, and drops it once the body is scrolled to its end. New task is the long form here, opened
 * on a short window so its body scrolls on every layout; the dialog is only opened, nothing is created.
 */

const SLUG = 'team-console';

test.beforeAll(async ({ stack }, testInfo) => {
  requireLocalStack(stack);
  await seed(stack, ['geeera/team-console']);
  await switchToConsoleTracker(testInfo.workerIndex, SLUG, 'TC');
});

async function openLongDialog(page: Page): Promise<{ foot: Locator; body: Locator }> {
  await page.setViewportSize({ width: 900, height: 360 });
  await page.goto(`/p/${SLUG}/board`);
  await expect(page.getByTestId('new-task-open')).toBeVisible();
  await page.getByTestId('new-task-open').click();
  const dialog = page.getByRole('dialog', { name: new RegExp(ru('quickTask.title')) });
  await expect(dialog).toBeVisible();
  const body = dialog.locator('.tc-sheet__body');
  // The form is taller than the short window: the body scrolls, so it is a named region.
  await expect(body).toHaveAttribute('role', 'region');
  return { foot: dialog.locator('.tc-sheet__foot'), body };
}

const scrollToEnd = (body: Locator): Promise<void> =>
  body.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });

test('the bar casts its shadow while text is under it and drops it at the end of the form', async ({
  page,
}) => {
  const { foot, body } = await openLongDialog(page);

  await expect(foot).toHaveClass(/tc-sheet__foot--lifted/);
  await expect(foot).not.toHaveCSS('box-shadow', 'none');
  await expectAccessible(page, 'Long dialog with the lifted footer');

  await scrollToEnd(body);

  await expect(foot).not.toHaveClass(/tc-sheet__foot--lifted/);
  await expect(foot).toHaveCSS('box-shadow', 'none');

  await body.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(foot).toHaveClass(/tc-sheet__foot--lifted/);
});

test('under reduced motion the shadow switches without a transition', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { foot, body } = await openLongDialog(page);

  await expect(foot).toHaveClass(/tc-sheet__foot--lifted/);
  await expect(foot).toHaveCSS('transition-property', 'none');
  await scrollToEnd(body);
  await expect(foot).toHaveCSS('box-shadow', 'none');
});
