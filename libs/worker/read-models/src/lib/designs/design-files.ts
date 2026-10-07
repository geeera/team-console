import {
  DESIGN_FILE_LIMIT,
  DESIGN_IMAGE_MAX_BYTES,
  type DesignDevice,
  type DesignImageType,
  type DesignInteractiveDto,
  type DesignManifestDto,
  type DesignRefKind,
  type DesignScreenDto,
} from '@shared/contracts';
import type { PullRequestRecord } from '../github-records';

/**
 * Design discovery (#277, spec §R): for design issue N, the files under `docs/design/` whose path has a segment
 * starting with `N-` — a folder `N-slug` anywhere below `docs/design`, or a file `N-slug.html` in a sub-folder —
 * read from one Git tree listing at one commit. Pure: the api Worker reads the tree and hands it here.
 */

export const DESIGN_ROOT = 'docs/design/';

/** A `screens.json` larger than this is ignored (captions fall back to the file names). */
export const SCREENS_JSON_MAX_BYTES = 64 * 1024;
const CAPTION_MAX_LENGTH = 120;

type JsonRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One blob of `GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1`. */
export interface TreeEntry {
  readonly path: string;
  /** The blob's object name; the file route reads bytes by it. */
  readonly sha: string;
  readonly size: number;
}

export interface TreeListing {
  readonly entries: readonly TreeEntry[];
  /** GitHub lists at most 100,000 entries; past that the listing is cut and says so. */
  readonly truncated: boolean;
}

const OBJECT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function isTreeItem(value: unknown): value is JsonRecord {
  return isRecord(value) && typeof value['path'] === 'string' && typeof value['type'] === 'string';
}

/** The tree answer's shape: `tree` is an array of items; `truncated` optional. */
export function isGitHubTree(value: unknown): value is JsonRecord {
  return (
    isRecord(value) &&
    Array.isArray(value['tree']) &&
    (value['truncated'] === undefined || typeof value['truncated'] === 'boolean')
  );
}

/** The blobs of a tree answer `isGitHubTree` accepted; items without a usable sha or size are skipped. */
export function treeListingOf(answer: JsonRecord): TreeListing {
  const tree = Array.isArray(answer['tree']) ? answer['tree'] : [];
  const entries: TreeEntry[] = [];
  for (const item of tree) {
    if (!isTreeItem(item) || item['type'] !== 'blob') {
      continue;
    }
    const sha = item['sha'];
    const size = item['size'];
    if (typeof sha !== 'string' || !OBJECT_SHA.test(sha) || typeof size !== 'number' || !(size >= 0)) {
      continue;
    }
    entries.push({ path: String(item['path']), sha, size });
  }
  return { entries, truncated: answer['truncated'] === true };
}

export interface DesignFiles {
  readonly files: readonly TreeEntry[];
  /** More than `DESIGN_FILE_LIMIT` files matched. */
  readonly partial: boolean;
}

function isPlainSegment(segment: string): boolean {
  return segment !== '' && segment !== '.' && segment !== '..';
}

/**
 * The files of issue `issue`: a path under `docs/design/` with every segment plain, one segment (not the last one
 * alone: `docs/design/277-foo.png` counts too) starting with `N-`, and no `src` folder after it (generator sources,
 * as the artifacts reader skips them). Sorted by path; at most `DESIGN_FILE_LIMIT`.
 */
export function designFilesOf(listing: TreeListing, issue: number): DesignFiles {
  const marker = `${issue}-`;
  const matched = listing.entries
    .filter((entry) => {
      if (!entry.path.startsWith(DESIGN_ROOT)) {
        return false;
      }
      const segments = entry.path.slice(DESIGN_ROOT.length).split('/');
      if (!segments.every(isPlainSegment)) {
        return false;
      }
      const at = segments.findIndex((segment) => segment.startsWith(marker));
      return at !== -1 && !segments.slice(at + 1).includes('src');
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files: matched.slice(0, DESIGN_FILE_LIMIT), partial: matched.length > DESIGN_FILE_LIMIT };
}

const IMAGE_TYPES: Readonly<Record<string, DesignImageType>> = {
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  webp: 'webp',
  gif: 'gif',
};

function extensionOf(file: string): string {
  const dot = file.lastIndexOf('.');
  return dot === -1 ? '' : file.slice(dot + 1).toLowerCase();
}

/** The image format a file name announces, or `null` for anything else (SVG included, on purpose). */
export function imageTypeOf(file: string): DesignImageType | null {
  return IMAGE_TYPES[extensionOf(file)] ?? null;
}

export function isHtmlFile(file: string): boolean {
  return extensionOf(file) === 'html';
}

export function fileNameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** `phone-01-loaded.png` → `phone`; `mac-02-images.png` → `mac`; anything else `null`. */
export function deviceOf(file: string): DesignDevice | null {
  if (file.startsWith('phone-')) {
    return 'phone';
  }
  return file.startsWith('mac-') ? 'mac' : null;
}

/** `phone-01-loaded.png` → `loaded`; `02-board.png` → `board`; a name with nothing left keeps its stem. */
export function captionOf(file: string): string {
  const stem = file.includes('.') ? file.slice(0, file.lastIndexOf('.')) : file;
  const words = stem
    .replace(/^(?:phone|mac)-/, '')
    .replace(/^\d+-?/, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  return words === '' ? stem : words;
}

/**
 * Captions from an optional `screens.json` beside the screens: `[{ "file": "phone-01-loaded.png", "title": "…" }]`.
 * Anything that is not that shape is ignored entry by entry; a body that is not a JSON array gives no captions.
 */
export function screenCaptionsOf(text: string): ReadonlyMap<string, string> {
  const captions = new Map<string, string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON: the file names stand in, as when there is no screens.json at all.
    return captions;
  }
  if (!Array.isArray(parsed)) {
    return captions;
  }
  for (const item of parsed.slice(0, DESIGN_FILE_LIMIT)) {
    if (!isRecord(item) || typeof item['file'] !== 'string' || typeof item['title'] !== 'string') {
      continue;
    }
    const title = item['title'].trim().slice(0, CAPTION_MAX_LENGTH);
    if (title !== '' && !item['file'].includes('/')) {
      captions.set(item['file'], title);
    }
  }
  return captions;
}

/** The `screens.json` of the issue's files, if one is listed and small enough to read. */
export function screensJsonOf(files: readonly TreeEntry[]): TreeEntry | null {
  return (
    files.find((file) => fileNameOf(file.path) === 'screens.json' && file.size <= SCREENS_JSON_MAX_BYTES) ??
    null
  );
}

export interface DesignManifestInput {
  readonly issue: number;
  readonly sha: string;
  readonly ref: DesignRefKind;
  readonly files: DesignFiles;
  readonly truncated: boolean;
  readonly captions: ReadonlyMap<string, string>;
  /** `owner/name`, already validated as a repository name. */
  readonly repo: { readonly owner: string; readonly name: string };
}

function encodedPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/** `https://<owner>.github.io/<repo>/<path under docs/design>`, the one place a Pages URL is built (spec §R). */
export function pagesUrlOf(repo: DesignManifestInput['repo'], path: string): string {
  const owner = repo.owner.toLowerCase();
  return `https://${owner}.github.io/${encodeURIComponent(repo.name)}/${encodedPath(path.slice(DESIGN_ROOT.length))}`;
}

export function designManifestOf(input: DesignManifestInput): DesignManifestDto {
  const blobBase = `https://github.com/${encodeURIComponent(input.repo.owner)}/${encodeURIComponent(input.repo.name)}/blob/${input.sha}/`;
  const screens: DesignScreenDto[] = [];
  let interactive: DesignInteractiveDto | null = null;
  for (const entry of input.files.files) {
    const file = fileNameOf(entry.path);
    const type = imageTypeOf(file);
    if (type !== null) {
      screens.push({
        path: entry.path,
        file,
        caption: input.captions.get(file) ?? captionOf(file),
        device: deviceOf(file),
        type,
        size: entry.size,
        tooLarge: entry.size > DESIGN_IMAGE_MAX_BYTES,
        url: `${blobBase}${encodedPath(entry.path)}`,
      });
    } else if (interactive === null && isHtmlFile(file)) {
      interactive = { path: entry.path, url: pagesUrlOf(input.repo, entry.path) };
    }
  }
  return {
    issue: input.issue,
    sha: input.sha,
    ref: input.ref,
    screens,
    interactive,
    partial: input.files.partial || input.truncated,
  };
}

/**
 * The open pull request that links issue N (spec §R: the design is not merged while it waits for approval): its
 * body or title mentions `#N` as a whole number, or its head branch has a segment starting with `N-`
 * (`design/277-viewer`). Pull requests come newest first; the first match wins. `null` when none does.
 */
export function linkingPullRequestOf(
  pulls: readonly PullRequestRecord[],
  issue: number,
): PullRequestRecord | null {
  const mention = new RegExp(`(?:^|[^0-9A-Za-z_])#${issue}(?![0-9])`);
  const branch = new RegExp(`(?:^|/)${issue}-`);
  return (
    pulls.find(
      (pull) =>
        pull.headSha !== null &&
        (mention.test(pull.title) ||
          mention.test(pull.body) ||
          (pull.headRef !== null && branch.test(pull.headRef))),
    ) ?? null
  );
}
