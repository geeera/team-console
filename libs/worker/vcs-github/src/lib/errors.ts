import { GitHubError, type GitHubProblemType } from '@worker/github';
import { VcsError, type VcsErrorKind } from '@worker/vcs';

const KIND_OF_PROBLEM: Readonly<Record<GitHubProblemType, VcsErrorKind>> = {
  'github-not-found': 'not-found',
  'github-rate-limit': 'rate-limited',
  'github-auth': 'forbidden',
  'github-app-not-installed': 'forbidden',
  'github-owner-mismatch': 'forbidden',
  'github-owner-not-connected': 'forbidden',
  'github-request-budget': 'unavailable',
  'github-unavailable': 'unavailable',
  'github-unexpected': 'unavailable',
};

/** A `GitHubError` as the adapter throws it: the same problem (clients keep their `github-*` types), a VCS kind. */
export function vcsErrorOf(error: GitHubError): VcsError {
  return new VcsError(KIND_OF_PROBLEM[error.problem.type], error.problem, error.githubStatus);
}

/** Runs one adapter read, translating GitHub's failures; anything else (a programming error) passes unchanged. */
export async function translated<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error: unknown) {
    if (error instanceof GitHubError) {
      throw vcsErrorOf(error);
    }
    throw error;
  }
}

/** `read`, with GitHub's 404 as `null` (a branch or a pull request that does not exist). */
export async function orNull<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error: unknown) {
    if (error instanceof GitHubError && error.problem.type === 'github-not-found') {
      return null;
    }
    throw error;
  }
}
