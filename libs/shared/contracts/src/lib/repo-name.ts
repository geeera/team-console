// Owner: GitHub logins are alphanumerics and hyphens. Name: alphanumerics, `.`, `_`, `-`. Anything else — `/`,
// `%`, `?`, `#`, whitespace — would let a registry row or a client steer a GitHub URL at another API path.
const REPO_FULL_NAME = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/;
// GitHub's own limits (39 for a login, 100 for a repository name); longer input is not a repository.
const MAX_OWNER = 39;
const MAX_NAME = 100;

/**
 * `owner` and `name` of an `owner/name` repository, or `null` when it is not one (ADR 0003 decision 6, #9 threat
 * row 2). The Worker's `parseRepoName` and the console's DTO guards share this one rule.
 */
export function repoFullNameParts(value: unknown): { readonly owner: string; readonly name: string } | null {
  if (typeof value !== 'string') {
    return null;
  }
  const match = REPO_FULL_NAME.exec(value);
  const owner = match?.[1];
  const name = match?.[2];
  if (
    owner === undefined ||
    name === undefined ||
    owner.length > MAX_OWNER ||
    name.length > MAX_NAME ||
    name === '.' ||
    name === '..'
  ) {
    return null;
  }
  return { owner, name };
}

export function isRepoFullName(value: unknown): value is string {
  return repoFullNameParts(value) !== null;
}
