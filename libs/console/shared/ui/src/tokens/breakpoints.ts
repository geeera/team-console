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

/**
 * The container thresholds (#766): a content layout switches on the width of the page body (`@container`), not of
 * the window, since the Commands and task panes take width from the body. Repeated from `tokens.css`
 * (`--cq-grid-min`, `--cq-wide-min`); `breakpoints.spec.ts` keeps them equal.
 */
export const CONTAINER_BREAKPOINTS = {
  /** Artifacts: the rows become a grid of cards. */
  grid: '(min-width: 880px)',
  /** The board: three columns (tasks, pull requests, runs). */
  wide: '(min-width: 1360px)',
} as const;

export type ContainerBreakpoint = keyof typeof CONTAINER_BREAKPOINTS;
