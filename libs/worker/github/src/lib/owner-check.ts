import { ownerMismatchError } from './errors';
import type { OwnerAccount } from './token-source';

/** `owner` of `GET /repos/{owner}/{repo}`. */
export interface RepoOwner {
  readonly login: string;
  readonly id: number;
}

/**
 * ADR 0003 decision 2(b), before every owner write and when a product is registered: the repository must belong to
 * the connected account — same login (case-insensitive) and the numeric id pinned at connect, so a renamed or
 * re-registered login does not pass. Otherwise 409 `github-owner-mismatch`.
 */
export function isRepoOwnedBy(account: OwnerAccount, owner: RepoOwner): boolean {
  return owner.login.toLowerCase() === account.login.toLowerCase() && owner.id === account.userId;
}

/** `isRepoOwnedBy`, or 409 `github-owner-mismatch` naming the repository and its owner. */
export function assertRepoOwnedBy(account: OwnerAccount, owner: RepoOwner, repo: string): void {
  if (!isRepoOwnedBy(account, owner)) {
    throw ownerMismatchError(repo, owner.login);
  }
}
