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
