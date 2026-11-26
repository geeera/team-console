/** The Settings › Team page of a project (#688), for the links to it. */
export function teamSettingsUrlOf(slug: string): string {
  return `/settings/projects/${encodeURIComponent(slug)}/team`;
}

/** `?focus=` values the Team page acts on once it has loaded. */
export const TEAM_FOCUS_BUDGET = 'budget';

/**
 * Team opened at Limits with the monthly budget focused (#688): the Needs-you "Open limits" link. Router commands
 * and query apart, so a `routerLink` never encodes the `?` into the path.
 */
export function teamLimitsLinkOf(slug: string): {
  readonly path: string;
  readonly queryParams: Readonly<Record<string, string>>;
} {
  return { path: teamSettingsUrlOf(slug), queryParams: { focus: TEAM_FOCUS_BUDGET } };
}
