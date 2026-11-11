import { isRepoOwnedBy, type OwnerAccount, type RepoOwner } from '@worker/github';

/** What GitHub answered for the registered name: the repository's owner and `owner/name` as GitHub spells it. */
export interface RepositoryEvidence {
  /** `null` when the read failed or answered no owner. */
  readonly owner: RepoOwner | null;
  /** `null` when the read failed. */
  readonly fullName: string | null;
  /** `true` when the read failed; such an answer never authorises a write. */
  readonly ownerCheckFailed?: boolean;
}

/**
 * #504, #509: the T-2 backfill records `projects.repo_id` only for the repository the row names (`repo`, any case),
 * owned by the connected owner. The id is immutable once written (0018), so a renamed or transferred name answered
 * by someone else's repository must not be recorded. Both write paths (the setup read and the pull-request sync)
 * decide through this one predicate.
 */
export function isBackfillAllowed(
  read: RepositoryEvidence,
  connection: OwnerAccount | null,
  repo: string,
): boolean {
  return (
    read.ownerCheckFailed !== true &&
    read.owner !== null &&
    connection !== null &&
    isRepoOwnedBy(connection, read.owner) &&
    read.fullName !== null &&
    read.fullName.toLowerCase() === repo.toLowerCase()
  );
}
