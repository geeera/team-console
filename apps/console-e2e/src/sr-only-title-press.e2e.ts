import type { Locator, Page } from '@playwright/test';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { heldMousePress } from './support/press';
import { emulatePush, fakePushDevice } from './support/push';
import { seed } from './support/stack';

/**
 * A page title kept for assistive tech on the phone (`tcSrOnlyOnPhone`) takes route-arrival focus and must not change
 * layout when it gets or loses it (#1031): a mouse press that moves focus off it would otherwise collapse it between
 * `mousedown` and `mouseup`, move the control out from under the pointer and lose the press (#959). A real, held
 * mouse press at phone width, so the desktop Chromium project only: a finger's tap delivers the click before the
 * collapse and would pass for the wrong reason.
 */
test.use({ viewport: { width: 390, height: 844 } });

test.beforeEach(async ({ stack, hasTouch }) => {
  test.skip(hasTouch === true, 'a mouse press: desktop project only');
  requireLocalStack(stack);
  await seed(stack, ['geeera/team-console']);
});

const title = (page: Page): Locator => page.locator('h1.tc-page__title');

/** Without this the press could pass for the wrong reason: Chrome's scroll anchoring hides a size change above. */
async function expectPressable(page: Page, target: Locator): Promise<void> {
  expect(await page.evaluate(() => window.scrollY), 'the page is not scrolled').toBe(0);
  const box = await target.boundingBox();
  const viewport = page.viewportSize();
  expect(box, 'the target is rendered').not.toBeNull();
  expect(viewport).not.toBeNull();
  if (box === null || viewport === null) {
    return;
  }
  expect(box.y, 'the target is inside the viewport').toBeGreaterThanOrEqual(0);
  expect(box.y + box.height, 'the target is inside the viewport').toBeLessThanOrEqual(viewport.height);
}

test('Settings: the first mouse press after arrival turns push on, the focused title stays hidden', async ({
  page,
  context,
  stack,
}) => {
  const subscription = await fakePushDevice(stack);
  await emulatePush(context, subscription, { permission: 'default', isSubscribed: false });

  await page.goto('/settings');
  const off = page.getByTestId('push-off');
  await expect(off).toBeVisible();
  await expect(title(page)).toBeFocused();
  // Soft, so a regression of the directive itself is named and the press below still shows its effect.
  await expect.soft(title(page)).toHaveClass(/\btc-sr-only\b/);
  const enable = off.getByRole('button', { name: ru('push.enable') });
  await expectPressable(page, enable);

  await heldMousePress(page, enable);

  await expect(page.getByTestId('push-on')).toBeVisible();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await expectAccessible(page, 'Settings at phone width, push on');
});

test('Needs you: after the nudge is dismissed, the next mouse press answers the card', async ({
  page,
  context,
  stack,
}) => {
  const subscription = await fakePushDevice(stack);
  await emulatePush(context, subscription, { permission: 'default', isSubscribed: false });

  await page.goto('/needs-you');
  const card = page.locator('li[data-number="72"]');
  await expect(card).toBeVisible();
  // A plain click: it is the dismissal that moves focus to the title, the press under test is the next one.
  await page.getByTestId('push-nudge-later').click();
  await expect(page.getByTestId('push-nudge')).toHaveCount(0);
  await expect(title(page)).toBeFocused();
  // Soft, so a regression of the directive itself is named and the press below still shows its effect.
  await expect.soft(title(page)).toHaveClass(/\btc-sr-only\b/);
  const approve = card.locator('[data-command="approve"]');
  await expectPressable(page, approve);

  await heldMousePress(page, approve);

  await expect(card.locator('tc-receipt')).toBeVisible();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await expectAccessible(page, 'Needs you at phone width, answered');
});
