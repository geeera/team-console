/**
 * GitHub content is untrusted (#9 threat rows 4 and 5): titles and bodies stay plain text, links are kept only
 * when they point at github.com, and the author's standing is carried along so the client can mark an item.
 */

const GITHUB_WEB = 'https://github.com/';

/** `html_url` when it is a github.com page, else `null` — a `javascript:` or any other URL is dropped. */
export function githubUrlOrNull(url: string): string | null {
  return url.startsWith(GITHUB_WEB) ? url : null;
}

// Outsiders on a public repository are NONE, FIRST_TIMER, FIRST_TIME_CONTRIBUTOR or CONTRIBUTOR.
const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/** The author is the repository owner, an organisation member or a collaborator. */
export function isTrustedAuthor(authorAssociation: string): boolean {
  return TRUSTED_ASSOCIATIONS.has(authorAssociation);
}
