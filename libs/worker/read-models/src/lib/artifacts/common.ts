import type { ArtifactDto, ArtifactType } from '@shared/contracts';
import type { IssueRecord } from '../github-records';
import { githubUrlOrNull } from '../untrusted-text';

/**
 * The Contents API's directory listing and file answers, narrowed to what the Artifacts space (#19) uses. A listing
 * holds at most 1,000 entries (GitHub's limit); the readers bound their reads well below that.
 */

type JsonRecord = Readonly<Record<string, unknown>>;

export interface ContentsEntry {
  readonly name: string;
  /** Repository path, e.g. `docs/decisions/0001-stack.md`. */
  readonly path: string;
  readonly kind: 'file' | 'dir' | 'other';
  /** The github.com page of the entry as GitHub gives it (kept as is: it may name a branch); `null` if not github.com. */
  readonly htmlUrl: string | null;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isGitHubContentsEntry(value: unknown): value is JsonRecord {
  return (
    isRecord(value) &&
    typeof value['name'] === 'string' &&
    typeof value['path'] === 'string' &&
    typeof value['type'] === 'string' &&
    (value['html_url'] === null || value['html_url'] === undefined || typeof value['html_url'] === 'string')
  );
}

/** A directory answer: an array of entries. A file path answers an object, which is not a listing. */
export function isGitHubContentsListing(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** Call only on a value `isGitHubContentsEntry` accepted. */
export function contentsEntryOf(raw: JsonRecord): ContentsEntry {
  const type = raw['type'];
  return {
    name: String(raw['name']),
    path: String(raw['path']),
    kind: type === 'file' ? 'file' : type === 'dir' ? 'dir' : 'other',
    htmlUrl: typeof raw['html_url'] === 'string' ? githubUrlOrNull(raw['html_url']) : null,
  };
}

/** The entries of a listing GitHub answered; anything that is not an entry is skipped. */
export function contentsEntriesOf(listing: readonly unknown[]): ContentsEntry[] {
  return listing.filter(isGitHubContentsEntry).map(contentsEntryOf);
}

/** UTF-8 text of base64 content as the Contents API sends it (line-wrapped). Throws on invalid base64. */
export function decodeBase64Text(content: string): string {
  const bytes = Uint8Array.from(atob(content.replace(/\s/g, '')), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** A Contents file answer's text; `null` for a directory, a file without inline content (over 1 MB) or bad base64. */
export function contentsFileTextOf(answer: unknown): string | null {
  if (!isRecord(answer) || answer['type'] !== 'file') {
    return null;
  }
  const content = answer['content'];
  if (answer['encoding'] !== 'base64' || typeof content !== 'string') {
    return null;
  }
  try {
    return decodeBase64Text(content);
  } catch {
    // Not base64 after all: the caller falls back to the file name, as for a missing file.
    return null;
  }
}

/** An issue as an artifact, or `null` for a pull request or an issue whose page is not on github.com. */
export function issueArtifactOf(type: ArtifactType, issue: IssueRecord): ArtifactDto | null {
  const url = githubUrlOrNull(issue.htmlUrl);
  if (issue.isPullRequest || url === null) {
    return null;
  }
  return { type, title: issue.title, url, updatedAt: issue.updatedAt, source: 'issue', state: issue.state };
}

/** Most recently updated first; undated after dated, then the higher number first. */
export function byRecentIssue(a: IssueRecord, b: IssueRecord): number {
  const left = a.updatedAt ?? '';
  const right = b.updatedAt ?? '';
  if (left !== right) {
    return left < right ? 1 : -1;
  }
  return b.number - a.number;
}
