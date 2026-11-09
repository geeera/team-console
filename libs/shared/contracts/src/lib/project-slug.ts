/**
 * A project slug is a URL segment (`/p/<slug>`), a read-cache key part and the suffix of a Worker secret name
 * (`ROUTINE_TOKEN_<SLUG>`), so it is validated strictly (#15).
 */
const PROJECT_SLUG = /^[a-z0-9][a-z0-9-]{1,38}$/;

/**
 * System slugs no project or account may take (ADR 0008 decision 1): every top-level segment of the console and the
 * API Worker, every `/api/v1` segment present or planned, and the owner's account (`owner`, created by migration
 * 0018). `p`, `a` and `t` are too short to be valid anyway; they are listed so the list reads as the ADR's.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  // ADR 0008 decision 1.
  'admin',
  'api',
  'owner',
  'settings',
  'needs-you',
  'overview',
  'github',
  'hooks',
  'runner',
  'accounts',
  'p',
  'a',
  't',
  // Top-level paths the api Worker or the assets answer (`run_worker_first`, the icon sets).
  'brand',
  'icons',
  // `/api/v1` segments, today's and the ones ADR 0008 plans.
  'auth',
  'environment',
  'healthz',
  'invites',
  'jobs',
  'projects',
  'push',
]);

export function isValidSlug(slug: string): boolean {
  return PROJECT_SLUG.test(slug) && !slug.endsWith('-');
}

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug);
}

/** The repository name in kebab case (`My_Repo.js` → `my-repo-js`), cut to the slug's length; may be invalid. */
export function slugFromRepoName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 39)
    .replace(/-+$/, '');
}

/** `ROUTINE_TOKEN_` + the slug upper-cased with `-` → `_`; only ever used to test a secret's presence. */
export function routineSecretName(slug: string): string {
  return `ROUTINE_TOKEN_${slug.toUpperCase().replace(/-/g, '_')}`;
}

/**
 * The two Worker secrets of a slot's routine trigger (#114): `SLOT_TOKEN_<SLUG>_<SLOT>` (the bearer) and
 * `SLOT_ROUTINE_<SLUG>_<SLOT>` (the `trig_…` id). Their own prefix, so `storify-dev`'s chat token can never collide
 * with `storify`'s development slot.
 */
export function slotSecretNames(
  slug: string,
  slot: 'pm' | 'dev' | 'qa',
): { readonly token: string; readonly routine: string } {
  const suffix = `${slug.toUpperCase().replace(/-/g, '_')}_${slot.toUpperCase()}`;
  return { token: `SLOT_TOKEN_${suffix}`, routine: `SLOT_ROUTINE_${suffix}` };
}
