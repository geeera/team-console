import { repoFullNameParts } from '@shared/contracts';

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

export class InvalidRepoNameError extends Error {
  constructor() {
    super('not a valid owner/name repository');
    this.name = 'InvalidRepoNameError';
  }
}

/** Validates `owner/name`; throws `InvalidRepoNameError` without echoing the input (it may be hostile). */
export function parseRepoName(value: string): RepoName {
  // The one rule, shared with the console's guards: no `/`, `%`, `?`, `#` or whitespace can steer the JWT.
  const parts = repoFullNameParts(value);
  if (parts === null) {
    throw new InvalidRepoNameError();
  }
  return { owner: parts.owner, name: parts.name, fullName: `${parts.owner}/${parts.name}` } as RepoName;
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
