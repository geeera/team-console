/** Minimum tap-target size (WCAG 2.5.5 / platform guidance), shared by every tap-target assertion. */
export const MIN_TAP_PX = 44;

/**
 * Playwright's `boundingBox()` returns fractional layout values, so a target that is exactly `MIN_TAP_PX` by CSS
 * can come back a few thousandths of a pixel short (#227). Round to the nearest pixel before comparing so that
 * subpixel rounding doesn't fail the check — a real shortfall (43.5 px and below) still fails.
 */
export function roundedPx(value: number | undefined): number {
  return Math.round(value ?? 0);
}
