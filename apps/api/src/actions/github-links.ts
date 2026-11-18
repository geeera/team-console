import type { RepoName } from '@worker/github';

/** The repository's page on github.com, each part encoded: the base of every link the Actions setup answers. */
export function repositoryUrlOf(repo: RepoName): string {
  return `https://github.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}
