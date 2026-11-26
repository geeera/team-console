import { test, type Locator, type Page } from '@playwright/test';

/**
 * Presses a control the way the project's device does: a tap on the touch projects, a click on the desktop. It does
 * not guard against layout moving under the pointer between `mousedown` and `mouseup`; a page must never do that
 * (#1031), and `heldMousePress` is how a spec proves it does not.
 */
export async function press(locator: Locator): Promise<void> {
  await (test.info().project.use.hasTouch === true ? locator.tap() : locator.click());
}

/**
 * A mouse press held for `holdMs` at the centre of the control, the way a person clicks. `click()` sends `mousedown`
 * and `mouseup` almost together, so a layout change that the focus move on `mousedown` triggers (#959) can land after
 * the click and go unnoticed; a held press gives the page the frames to render it first.
 */
export async function heldMousePress(page: Page, locator: Locator, holdMs = 100): Promise<void> {
  const box = await locator.boundingBox();
  if (box === null) {
    throw new Error('heldMousePress: the control has no box; is it rendered and visible?');
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // The hold is the test input, not a wait for the page: the time a real press keeps the button down.
  await page.waitForTimeout(holdMs);
  await page.mouse.up();
}
