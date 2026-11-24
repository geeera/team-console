import type { Page } from '@playwright/test';

/**
 * Waits until every running finite animation has finished (infinite ones, such as the live dot, never do).
 * A route enter (#506) rises the page for 240 ms, so a bounding box read right after navigation can be off by a
 * sub-pixel amount; measure after this.
 */
export async function settled(page: Page): Promise<void> {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished),
    ),
  );
}
