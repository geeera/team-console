/**
 * The layout breakpoints as media queries for the CDK `BreakpointObserver`.
 * Custom properties cannot drive `@media`, so the numbers are repeated from
 * `tokens.css` (`--bp-phone-max`, `--bp-tablet-max`); `breakpoints.spec.ts` keeps them equal.
 */
export const BREAKPOINTS = {
  /** iPhone widths: bottom sheets, tab bar, full-bleed cards. */
  phone: '(max-width: 519.98px)',
  /** Up to a small tablet: single column, collapsed sidebar. */
  tablet: '(max-width: 899.98px)',
} as const;

export type Breakpoint = keyof typeof BREAKPOINTS;
