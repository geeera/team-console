import type { Page } from '@playwright/test';
import {
  endlessAnimationsMessage,
  type FinishOptions,
  finishRunningAnimations,
  refusedAnimationsMessage,
  restlessAnimationsMessage,
} from './finish-animations';

/**
 * A chain of animations (a `tc-roll` through several values, then a badge shrinking out) ends in a handful of
 * passes; twenty without coming to rest is a page that animates forever, and is reported instead of looped on.
 * Two frames between passes: one sends the finished animations' `animationend`, one lets its handler render.
 */
const FINISH: FinishOptions = { maxRounds: 20, framesBetweenRounds: 2 };

/**
 * What to do about a running animation that repeats forever (`finish()` throws on those): `'leave'` it running — a
 * spinner or the live dot does not move what a test measures — or `'fail'`, naming it, for the axe gate, which would
 * otherwise measure contrast on a frame in the middle of it.
 */
export type EndlessAnimations = 'leave' | 'fail';

/**
 * Jumps every running finite animation to its end state (`Animation.finish()`), and keeps doing so until the page
 * starts no more. The one finite-animation check shared by `settled()` and the axe gate (#972); it waits for no
 * animation's own clock, so a lagging or stuck one cannot hang or fail it (#971). Paused animations stay as they are.
 */
export async function finishAnimations(page: Page, endless: EndlessAnimations): Promise<void> {
  const result = await page.evaluate(finishRunningAnimations, FINISH);
  if (result.refused.length > 0) {
    throw new Error(refusedAnimationsMessage(result.refused));
  }
  if (result.restless.length > 0) {
    throw new Error(restlessAnimationsMessage(result.restless, FINISH.maxRounds));
  }
  if (endless === 'fail' && result.endless.length > 0) {
    throw new Error(endlessAnimationsMessage(result.endless));
  }
}

/**
 * Brings every running finite animation to its end state (infinite ones, such as the live dot, never end; paused
 * ones, such as a hovered Undo toast's hairline, stand still). A route enter (#506) rises the page for 240 ms, so a
 * bounding box read right after navigation can be off by a sub-pixel amount; measure after this.
 */
export async function settled(page: Page): Promise<void> {
  await finishAnimations(page, 'leave');
}
