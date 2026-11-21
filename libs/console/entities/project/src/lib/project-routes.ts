/**
 * Where projects are added and set up. Every "Add project" entry point opens All projects at its "Available on
 * GitHub" section (#194, owner decision 2026-10-05); the #24 setup page keeps its `/settings/projects/:slug`
 * address until it moves out of Settings.
 */
export const ADD_PROJECT_PATH = '/overview';
/** The fragment All projects reads to scroll to the GitHub section and focus its heading. */
export const ADD_PROJECT_FRAGMENT = 'add-project';
/** For `navigateByUrl` and `redirectTo`. */
export const ADD_PROJECT_URL = `${ADD_PROJECT_PATH}#${ADD_PROJECT_FRAGMENT}`;

/** Router commands for a project's setup page; the router encodes the slug. */
export function projectSetupRouteOf(slug: string): readonly string[] {
  return ['/settings/projects', slug];
}

/**
 * Router commands for a project's environment screen (#750): a sub-page of its setup, so it moves with setup when
 * setup leaves `/settings`.
 */
export function projectEnvironmentRouteOf(slug: string): readonly string[] {
  return [...projectSetupRouteOf(slug), 'environment'];
}

/** One item's guide on that screen: `:env` is in the guide's URL only, `name` the expanded secret name. */
export function projectEnvironmentGuideRouteOf(
  slug: string,
  environment: string,
  name: string,
): readonly string[] {
  return [...projectEnvironmentRouteOf(slug), environment, name];
}

/** Router commands for a project's GitHub Actions setup (#759): a sibling of its environment screen. */
export function projectActionsRouteOf(slug: string): readonly string[] {
  return [...projectSetupRouteOf(slug), 'actions'];
}
