/**
 * The head branch of the console's setup PR (#759; architect note §3 row "PR content integrity"): a constant prefix
 * and the first 12 hex characters of the rendering's sha256, so the branch names the exact file it carries and the
 * readiness check finds the PR again without storing anything.
 */
export const ACTIONS_SETUP_BRANCH_PREFIX = 'team-console/runner-';

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function actionsSetupBranchOf(sha256: string): string {
  if (!SHA256_HEX.test(sha256)) {
    throw new RangeError('a setup branch is named after a lower-case hex sha256');
  }
  return `${ACTIONS_SETUP_BRANCH_PREFIX}${sha256.slice(0, 12)}`;
}
