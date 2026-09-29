import type { RepoName } from './repo-name';

/**
 * A path (plus query) on `https://api.github.com`. Built only by `githubPath`, which encodes every interpolated
 * value, so no caller can splice a raw string into a GitHub URL.
 */
export type GitHubPath = string & { readonly [githubPathBrand]: true };

declare const githubPathBrand: unique symbol;

export type GitHubPathValue = RepoName | string | number;

function isRepoName(value: GitHubPathValue): value is RepoName {
  return typeof value === 'object';
}

function encodeValue(value: GitHubPathValue): string {
  if (isRepoName(value)) {
    return `${encodeURIComponent(value.owner)}/${encodeURIComponent(value.name)}`;
  }
  if (typeof value === 'number' && !(Number.isSafeInteger(value) && value >= 0)) {
    throw new Error('GitHub path numbers must be non-negative integers');
  }
  return encodeURIComponent(String(value));
}

/**
 * Tagged template: literal parts come from our code, values are encoded segment by segment —
 * githubPath`/repos/${repo}/issues?per_page=${100}`. A `RepoName` becomes `owner/name` with each part encoded.
 */
export function githubPath(
  literals: TemplateStringsArray,
  ...values: readonly GitHubPathValue[]
): GitHubPath {
  if (!literals[0]?.startsWith('/')) {
    throw new Error('a GitHub path starts with /');
  }
  let path = literals[0];
  values.forEach((value, index) => {
    path += encodeValue(value) + (literals[index + 1] ?? '');
  });
  return path as GitHubPath;
}

/** Re-brands the path of a URL already checked to be on api.github.com (pagination `Link`, same-host redirects). */
export function githubPathOf(url: URL): GitHubPath {
  return `${url.pathname}${url.search}` as GitHubPath;
}
