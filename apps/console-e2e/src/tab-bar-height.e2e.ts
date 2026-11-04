import type { Page } from '@playwright/test';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { seed } from './support/stack';

/**
 * The phone's bottom tab bar is sized by `--tab-bar-h` (#404), the token the shell's `scroll-padding-bottom` reads to
 * keep a focused control clear of the bar (#192). The rendered bar must be exactly the token's height plus the
 * safe-area inset, so a taller label or a padding change shows up here instead of hiding controls under the bar.
 */

const BOARD = '/p/team-console/board';

test.beforeEach(async ({ stack }) => {
  test.skip(test.info().project.name !== 'iphone', 'the bottom tab bar is the phone layout');
  requireLocalStack(stack);
  await seed(stack, ['geeera/team-console']);
});

async function barAndTokenHeights(page: Page): Promise<{ bar: number; token: number }> {
  const bar = page.locator('nav.tc-tab-bar--bottom');
  await expect(bar).toBeVisible();
  return bar.evaluate((element) => {
    const probe = document.createElement('div');
    probe.style.height = 'calc(var(--tab-bar-h) + var(--safe-bottom))';
    element.parentElement?.append(probe);
    const token = probe.getBoundingClientRect().height;
    probe.remove();
    return { bar: element.getBoundingClientRect().height, token };
  });
}

for (const locale of ['ru-RU', 'en-US'] as const) {
  test.describe(`the bottom tab bar (${locale})`, () => {
    test.use({ locale });

    test('is as tall as --tab-bar-h plus the safe-area inset', async ({ page }) => {
      await page.goto(BOARD);

      const { bar, token } = await barAndTokenHeights(page);

      expect(token).toBeGreaterThan(0);
      expect(Math.abs(bar - token), `bar ${bar}px, token ${token}px`).toBeLessThan(0.5);
      await expectAccessible(page, `Board with the bottom tab bar (${locale})`);
    });
  });
}
