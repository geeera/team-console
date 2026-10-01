/**
 * A project slug is a URL segment (`/p/<slug>`), a read-cache key part and the suffix of a Worker secret name
 * (`ROUTINE_TOKEN_<SLUG>`), so it is validated strictly (#15).
 */
const PROJECT_SLUG = /^[a-z0-9][a-z0-9-]{1,38}$/;

/** Top-level console routes a project slug would shadow. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set(['needs-you', 'overview', 'settings', 'api']);

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
