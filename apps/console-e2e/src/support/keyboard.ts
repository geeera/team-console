import type { Locator, Page } from '@playwright/test';

/**
 * Tabs forward until `target` has focus: the keyboard-only path, no click. `from` is a nearby control focused first
 * (the row above, the bar's other button), so the walk is a few presses rather than the whole iPhone page; a press
 * that never lands is a failure after `limit`, not a timeout. The check is one marker read per press.
 */
export async function tabTo(page: Page, target: Locator, from?: Locator, limit = 12): Promise<void> {
  await target.evaluate((element) => element.setAttribute('data-tab-target', ''));
  if (from !== undefined) {
    await from.focus();
  }
  try {
    for (let step = 0; step <= limit; step += 1) {
      if (await page.evaluate(() => document.activeElement?.hasAttribute('data-tab-target') === true)) {
        return;
      }
      await page.keyboard.press('Tab');
    }
    throw new Error(`Tab never reached ${String(target)} in ${String(limit)} presses`);
  } finally {
    await target.evaluate((element) => element.removeAttribute('data-tab-target'));
  }
}

/** Whether the page, or any scroller in it or in an open sheet, scrolls sideways (a phone's 375 px check). */
export async function scrollsSideways(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const scrollers = [...document.querySelectorAll<HTMLElement>('*')].filter((element) => {
      const overflowX = getComputedStyle(element).overflowX;
      return overflowX === 'auto' || overflowX === 'scroll';
    });
    return [document.documentElement, ...scrollers].some((element) => element.scrollWidth > element.clientWidth + 1);
  });
}
