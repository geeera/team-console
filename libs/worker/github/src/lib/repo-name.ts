/**
 * A repository name that passed validation. Only `parseRepoName` creates one, so a `RepoName` in a signature
 * proves the check ran before the value reaches a URL (ADR 0003 decision 6, #9 threat row 2).
 */
export interface RepoName {
  readonly owner: string;
  readonly name: string;
  /** `owner/name` as given (GitHub is case-insensitive; callers compare with `sameRepo`). */
  readonly fullName: string;
  readonly [repoNameBrand]: true;
}

declare const repoNameBrand: unique symbol;

// Owner: GitHub logins are alphanumerics and hyphens. Name: alphanumerics, `.`, `_`, `-`. Anything else — `/`,
// `%`, `?`, `#`, whitespace — would let a registry row or a client steer the JWT at another API path.
const REPO_PATTERN = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/;
// GitHub's own limits (39 for a login, 100 for a repository name); longer input is not a repository.
const MAX_OWNER = 39;
const MAX_NAME = 100;

export class InvalidRepoNameError extends Error {
  constructor() {
    super('not a valid owner/name repository');
    this.name = 'InvalidRepoNameError';
  }
}

/** Validates `owner/name`; throws `InvalidRepoNameError` without echoing the input (it may be hostile). */
export function parseRepoName(value: string): RepoName {
  const match = REPO_PATTERN.exec(value);
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
    throw new InvalidRepoNameError();
  }
  return { owner, name, fullName: `${owner}/${name}` } as RepoName;
}

export function isValidRepoName(value: string): boolean {
  try {
    parseRepoName(value);
    return true;
  } catch (error: unknown) {
    if (error instanceof InvalidRepoNameError) {
      return false;
    }
    throw error;
  }
}

/** GitHub treats owner and repository names case-insensitively. */
export function sameRepo(a: RepoName, b: RepoName): boolean {
  return a.fullName.toLowerCase() === b.fullName.toLowerCase();
}
