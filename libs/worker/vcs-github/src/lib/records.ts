import { isRepoFullName } from '@shared/contracts';
import type { Branch, ChangedFile, ChangedFileStatus, PullRequest, Repository } from '@worker/vcs';

/**
 * GitHub's JSON narrowed into the neutral VCS types, from REST answers and webhook payloads alike (a delivery's
 * `pull_request` is the REST shape). Every function returns `null` for a value of another shape, never a partial
 * record: GitHub's text is untrusted, and only what passed here reaches D1.
 */

type JsonRecord = Readonly<Record<string, unknown>>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function objectAt(source: JsonRecord, key: string): JsonRecord | null {
  const value = source[key];
  return isRecord(value) ? value : null;
}

function stringAt(source: JsonRecord, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' ? value : null;
}

function positiveIntAt(source: JsonRecord, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function countAt(source: JsonRecord, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

const SHA = /^[0-9a-f]{40}$/;

export function isCommitSha(value: unknown): value is string {
  return typeof value === 'string' && SHA.test(value);
}

// git check-ref-format's rules that matter for a path or a column: no control characters, space, `~^:?*[\`, no `..`,
// no `@{`, not ending in `.lock` or `/`. GitHub caps branch names at 255 bytes.
const REF_FORBIDDEN = /[~^:?*[\\]/;

/** A C0 control character, a space or DEL anywhere in `value`. */
function hasControlOrSpace(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function isBranchName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 255 &&
    !REF_FORBIDDEN.test(value) &&
    !hasControlOrSpace(value) &&
    !value.includes('..') &&
    !value.includes('@{') &&
    !value.includes('//') &&
    !value.startsWith('/') &&
    !value.startsWith('-') &&
    !value.endsWith('/') &&
    !value.endsWith('.') &&
    !value.endsWith('.lock') &&
    value !== '@'
  );
}

/** GitHub's 256-character title limit, with room for the multi-unit characters `length` counts twice. */
export const TITLE_MAX_LENGTH = 1024;
const LOGIN_MAX_LENGTH = 39;

/** An ISO 8601 instant normalised to `toISOString` (`…T10:00:00.000Z`), so stored values compare as strings. */
export function instantOf(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value)) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** The pull request's page, built from the repository and number (a payload's `html_url` is never stored). */
export function pullRequestUrlOf(fullName: string, number: number): string {
  const [owner = '', name = ''] = fullName.split('/');
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pull/${String(number)}`;
}

/**
 * A pull request of `repoFullName` (REST `GET …/pulls/{n}`, a list item or a webhook's `pull_request`). `merged_at`
 * set means merged, whatever `state` says; `draft` absent (old payloads) means not a draft.
 */
export function pullRequestOf(raw: unknown, repoFullName: string): PullRequest | null {
  if (!isRecord(raw) || !isRepoFullName(repoFullName)) {
    return null;
  }
  const id = positiveIntAt(raw, 'id');
  const number = positiveIntAt(raw, 'number');
  const title = stringAt(raw, 'title');
  const state = stringAt(raw, 'state');
  const head = objectAt(raw, 'head');
  const base = objectAt(raw, 'base');
  const updatedAt = instantOf(raw['updated_at']);
  const draft = raw['draft'];
  const mergedAt = raw['merged_at'];
  if (
    id === null ||
    number === null ||
    title === null ||
    title.length > TITLE_MAX_LENGTH ||
    (state !== 'open' && state !== 'closed') ||
    head === null ||
    base === null ||
    updatedAt === null ||
    (draft !== undefined && typeof draft !== 'boolean') ||
    (mergedAt !== undefined && mergedAt !== null && instantOf(mergedAt) === null)
  ) {
    return null;
  }
  const headRef = stringAt(head, 'ref');
  const headSha = stringAt(head, 'sha');
  const baseRef = stringAt(base, 'ref');
  if (!isBranchName(headRef) || !isCommitSha(headSha) || !isBranchName(baseRef)) {
    return null;
  }
  const headRepoValue = objectAt(head, 'repo');
  const headRepository = headRepoValue === null ? null : stringAt(headRepoValue, 'full_name');
  const user = objectAt(raw, 'user');
  const login = user === null ? null : stringAt(user, 'login');
  const isMerged = typeof mergedAt === 'string';
  return {
    externalId: String(id),
    number,
    title,
    state: isMerged ? 'merged' : state,
    draft: draft === true,
    headRef,
    headSha,
    baseRef,
    headRepository: isRepoFullName(headRepository) ? headRepository : null,
    authorLogin: login !== null && login.length <= LOGIN_MAX_LENGTH ? login : null,
    url: pullRequestUrlOf(repoFullName, number),
    updatedAt,
  };
}

/** `GET /repos/{owner}/{repo}`. */
export function repositoryOf(raw: unknown): Repository | null {
  if (!isRecord(raw)) {
    return null;
  }
  const id = positiveIntAt(raw, 'id');
  const fullName = stringAt(raw, 'full_name');
  const defaultBranch = stringAt(raw, 'default_branch');
  const isPrivate = raw['private'];
  if (
    id === null ||
    !isRepoFullName(fullName) ||
    !isBranchName(defaultBranch) ||
    typeof isPrivate !== 'boolean'
  ) {
    return null;
  }
  const [owner = '', name = ''] = fullName.split('/');
  return {
    externalId: String(id),
    fullName,
    defaultBranch,
    visibility: isPrivate ? 'private' : 'public',
    htmlUrl: `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
  };
}

/** `GET …/branches/{name}` and a `GET …/branches` item (`protected` absent on old answers means unprotected). */
export function branchOf(raw: unknown): Branch | null {
  if (!isRecord(raw)) {
    return null;
  }
  const name = stringAt(raw, 'name');
  const commit = objectAt(raw, 'commit');
  const sha = commit === null ? null : stringAt(commit, 'sha');
  const isProtected = raw['protected'];
  if (
    !isBranchName(name) ||
    !isCommitSha(sha) ||
    (isProtected !== undefined && typeof isProtected !== 'boolean')
  ) {
    return null;
  }
  return { name, sha, protected: isProtected === true };
}

const FILE_STATUSES: ReadonlySet<string> = new Set<ChangedFileStatus>([
  'added',
  'removed',
  'modified',
  'renamed',
  'copied',
  'changed',
  'unchanged',
]);

function isFileStatus(value: string | null): value is ChangedFileStatus {
  return value !== null && FILE_STATUSES.has(value);
}

const PATH_MAX_LENGTH = 4096;

function isRepoPath(value: string | null): value is string {
  return value !== null && value.length >= 1 && value.length <= PATH_MAX_LENGTH && !value.includes('\u0000');
}

/** `GET …/pulls/{n}/files` item. */
export function changedFileOf(raw: unknown): ChangedFile | null {
  if (!isRecord(raw)) {
    return null;
  }
  const path = stringAt(raw, 'filename');
  const status = stringAt(raw, 'status');
  const additions = countAt(raw, 'additions');
  const deletions = countAt(raw, 'deletions');
  const previous = raw['previous_filename'];
  if (
    !isRepoPath(path) ||
    !isFileStatus(status) ||
    additions === null ||
    deletions === null ||
    (previous !== undefined && (typeof previous !== 'string' || !isRepoPath(previous)))
  ) {
    return null;
  }
  return { path, previousPath: typeof previous === 'string' ? previous : null, status, additions, deletions };
}
