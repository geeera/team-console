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

/**
 * `/repos/{owner}/{repo}/contents/{path}` for a repository path that comes from configuration (project.yml's
 * `decisions_dir`) or a listing: each segment is encoded on its own, so the slashes stay, and an empty, `.` or `..`
 * segment is refused rather than resolved.
 */
export function githubContentsPath(repo: RepoName, path: string): GitHubPath {
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('a contents path is relative, without empty, . or .. segments');
  }
  const base = githubPath`/repos/${repo}/contents`;
  return `${base}/${segments.map((segment) => encodeURIComponent(segment)).join('/')}` as GitHubPath;
}

/** Re-brands the path of a URL already checked to be on api.github.com (pagination `Link`, same-host redirects). */
export function githubPathOf(url: URL): GitHubPath {
  return `${url.pathname}${url.search}` as GitHubPath;
}
