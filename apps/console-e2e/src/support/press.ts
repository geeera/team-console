import { test, type Locator } from '@playwright/test';

/**
 * Presses a control the way the project's device does: a tap on the touch projects, a click on the desktop.
 *
 * `click()` is a mouse press: `mousedown` and `mouseup` reach the page as two separate inputs, and a frame can render
 * between them. `mousedown` already moves focus, so on the phone layout a page title shown only while it has focus
 * (`tcSrOnlyOnPhone`) collapses in that gap, the control moves out from under the pointer, and the click lands on
 * the page behind it (#959). A finger's tap sends both, and the click, in one step.
 */
export async function press(locator: Locator): Promise<void> {
  await (test.info().project.use.hasTouch === true ? locator.tap() : locator.click());
}
