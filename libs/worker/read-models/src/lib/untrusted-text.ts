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

/**
 * The team's GitHub App, trusted by the owner's decision on #35 (2026-09-30). GitHub reports its issues as
 * CONTRIBUTOR. A `…[bot]` login belongs to exactly one GitHub App and no user can register it, so login plus
 * `type: Bot` identifies the app; a user named `team-console-team` or any other bot stays untrusted.
 */
export const TRUSTED_BOT_LOGINS: ReadonlySet<string> = new Set(['team-console-team[bot]']);

/** Who opened an issue or pull request, as GitHub reports it (`user` is null for a deleted account). */
export interface IssueAuthor {
  readonly authorAssociation: string;
  readonly authorLogin: string | null;
  readonly authorType: string | null;
}

/** The repository owner, an organisation member, a collaborator, or the team's own app. */
export function isTrustedAuthor(author: IssueAuthor): boolean {
  if (TRUSTED_ASSOCIATIONS.has(author.authorAssociation)) {
    return true;
  }
  return (
    author.authorType === 'Bot' && author.authorLogin !== null && TRUSTED_BOT_LOGINS.has(author.authorLogin)
  );
}
