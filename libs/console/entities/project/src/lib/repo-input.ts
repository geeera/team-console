import { isReservedSlug, isValidSlug, slugFromRepoName } from '@shared/contracts';

/** The #24 UX spec's format; the Worker's own check (`parseRepoName`) is the authority and runs again on add. */
const REPO = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/;
const GITHUB_REPO_URL =
  /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/?#\s]+)\/([^/?#\s]+?)(?:\.git)?\/?(?:[?#].*)?$/i;

export type RepoInput =
  | { readonly ok: true; readonly repo: string; readonly slug: string }
  | { readonly ok: false; readonly reason: 'empty' | 'format' };

/**
 * What the owner typed or pasted into New project, as the `owner/repo` the registry gets: surrounding whitespace
 * trimmed, a `https://github.com/owner/repo(.git)` link reduced to `owner/repo`. Also the slug the Worker will
 * derive (`/p/{slug}` preview); a name whose slug the Worker would refuse is a format error here already.
 */
export function normalizeRepoInput(raw: string): RepoInput {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ok: false, reason: 'empty' };
  }
  const link = GITHUB_REPO_URL.exec(trimmed);
  const candidate = link === null ? trimmed : `${link[1]}/${link[2]}`;
  const match = REPO.exec(candidate);
  const name = match?.[2];
  if (match === null || name === undefined || name === '.' || name === '..') {
    return { ok: false, reason: 'format' };
  }
  const slug = slugFromRepoName(name);
  if (!isValidSlug(slug) || isReservedSlug(slug)) {
    return { ok: false, reason: 'format' };
  }
  return { ok: true, repo: candidate, slug };
}
