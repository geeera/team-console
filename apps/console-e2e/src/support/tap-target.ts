/** Minimum tap-target size (WCAG 2.5.5 / platform guidance), shared by every tap-target assertion. */
export const MIN_TAP_PX = 44;

/**
 * Playwright's `boundingBox()` returns fractional layout values, so a target that is exactly `MIN_TAP_PX` by CSS
 * can come back a few thousandths of a pixel short (#227) — e.g. `43.99998...`. `EPSILON_PX` absorbs only that
 * float noise; a real shortfall (43.99 px and below) still fails `meetsMinTap`.
 */
const EPSILON_PX = 0.01;

/** `true` when `value` is at least `min` once sub-pixel float noise from `boundingBox()` is absorbed. */
export function meetsMinTap(value: number | undefined, min: number = MIN_TAP_PX): boolean {
  return (value ?? 0) >= min - EPSILON_PX;
}
