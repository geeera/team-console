import type { Page } from '@playwright/test';

/**
 * Waits until every running finite animation has finished (infinite ones, such as the live dot, never do).
 * A route enter (#506) rises the page for 240 ms, so a bounding box read right after navigation can be off by a
 * sub-pixel amount; measure after this.
 *
 * A navigation or a next value (#946) can cancel an animation (`.m-route`'s previous page, `tc-roll`'s mid-step
 * element) before it finishes: `finished` then rejects with `AbortError`, which is a cancelled animation settling,
 * not a failure to wait for.
 */
export async function settled(page: Page): Promise<void> {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) =>
          animation.finished.catch((error: unknown) => {
            if (error instanceof DOMException && error.name === 'AbortError') {
              return;
            }
            throw error;
          }),
        ),
    ),
  );
}
