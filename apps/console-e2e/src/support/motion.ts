import type { Page } from '@playwright/test';
import { settlePage } from './animation-settle';

/**
 * Waits until every running finite animation has finished (infinite ones, such as the live dot, never do; paused
 * ones, such as a hovered Undo toast's hairline, stand still and are not waited for either). A route enter (#506)
 * rises the page for 240 ms, so a bounding box read right after navigation can be off by a sub-pixel amount;
 * measure after this.
 *
 * It is the same bounded wait the axe gate uses (`settlePage`, #971): a cancelled animation (`AbortError`) counts as
 * settled, and one that outlives its wait fails with the animation and element named instead of hanging.
 */
export async function settled(page: Page): Promise<void> {
  await settlePage(page);
}
