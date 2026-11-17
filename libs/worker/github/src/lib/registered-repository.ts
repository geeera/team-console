import type { GitHubClient } from './client';
import { githubPath } from './github-path';
import { parseRepoName, type RepoName } from './repo-name';

/** What `GET /repos/{owner}/{repo}` must answer for a registered repository to be checked (#670, #695). */
interface RepositoryAnswer {
  readonly id: number;
  readonly full_name: string;
  readonly default_branch: string;
}

function isRepositoryAnswer(value: unknown): value is RepositoryAnswer {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record['id'] === 'number' &&
    typeof record['full_name'] === 'string' &&
    typeof record['default_branch'] === 'string' &&
    record['default_branch'] !== ''
  );
}

/** The repository GitHub names under the registered name, once its `id` is the one the console recorded. */
export interface VerifiedRepository {
  /** GitHub's current name: a renamed repository answers the old one through a redirect a POST does not follow. */
  readonly current: RepoName;
  /** Always GitHub's answer, never input (#695 item 4). */
  readonly defaultBranch: string;
}

/**
 * Reads the repository by its registered name and requires GitHub's `id` to be `repoId` (`projects.repo_id`): the
 * check both the Actions dispatch and the switch to it make (#724). `null` when GitHub names another repository
 * under that name. GitHub's own refusals are thrown as `GitHubError`, a `full_name` that is no valid name as
 * `InvalidRepoNameError`.
 */
export async function readRegisteredRepository(
  client: GitHubClient,
  registered: RepoName,
  repoId: number,
): Promise<VerifiedRepository | null> {
  const read = await client.getJson(githubPath`/repos/${registered}`, isRepositoryAnswer);
  if (read.id !== repoId) {
    return null;
  }
  return { current: parseRepoName(read.full_name), defaultBranch: read.default_branch };
}
