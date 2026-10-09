/**
 * The design viewer (#277, shared with the question cards of #276): the files a design issue's team put under
 * `docs/design/**` whose path has a segment starting with `N-`, read at one commit of the repository and served by
 * the api Worker as plain images. Captions and titles are GitHub text (render as plain text only).
 */

export const DESIGN_IMAGE_TYPES = ['png', 'jpeg', 'webp', 'gif'] as const;

/** The image formats the Worker serves: raster only, because SVG can carry script. */
export type DesignImageType = (typeof DESIGN_IMAGE_TYPES)[number];

/** Which device a screen was drawn for, from its `phone-` / `mac-` file-name prefix. */
export type DesignDevice = 'phone' | 'mac';

/** At most this many files are listed for one design issue; the rest are reported as `partial`. */
export const DESIGN_FILE_LIMIT = 40;

/** An image larger than this is listed but never served (`tooLarge`). */
export const DESIGN_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export interface DesignScreenDto {
  /** Repository path, e.g. `docs/design/277-design-viewer/phone-01-list.png`. */
  readonly path: string;
  /** The file name alone. */
  readonly file: string;
  /** From `screens.json` when it names the file, else from the file name (`phone-01-loaded` → `loaded`). */
  readonly caption: string;
  readonly device: DesignDevice | null;
  readonly type: DesignImageType;
  /** Bytes, as the tree lists them. */
  readonly size: number;
  /** Over `DESIGN_IMAGE_MAX_BYTES`: the viewer shows a note and a GitHub link instead of asking for the file. */
  readonly tooLarge: boolean;
  /** The file's github.com page at the manifest's commit. */
  readonly url: string;
}

export interface DesignInteractiveDto {
  /** Repository path of the first HTML file, e.g. `docs/design/277-design-viewer/wireframe.html`. */
  readonly path: string;
  /**
   * Where GitHub Pages would publish it (`https://<owner>.github.io/<repo>/<path under docs/design>`). The console
   * frames it only when that origin is one of the project's embed origins (#20); otherwise it is a link.
   */
  readonly url: string;
}

/** Which commit the files were read at: the head of the open pull request that links the issue, else the default branch. */
export type DesignRefKind = 'pull-request' | 'default-branch';

export interface DesignManifestDto {
  readonly issue: number;
  /** The commit every path is pinned to (the file route takes it back). */
  readonly sha: string;
  readonly ref: DesignRefKind;
  /** Image screens in file-name order. */
  readonly screens: readonly DesignScreenDto[];
  readonly interactive: DesignInteractiveDto | null;
  /** The issue's folder holds more than `DESIGN_FILE_LIMIT` files, or GitHub truncated the tree listing. */
  readonly partial: boolean;
}

export function isDesignImageType(value: unknown): value is DesignImageType {
  return typeof value === 'string' && (DESIGN_IMAGE_TYPES as readonly string[]).includes(value);
}

export function isDesignDevice(value: unknown): value is DesignDevice {
  return value === 'phone' || value === 'mac';
}

// SHA-1 (40) or SHA-256 (64) object names, lowercase.
const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function isCommitSha(value: unknown): value is string {
  return typeof value === 'string' && COMMIT_SHA.test(value);
}

/** `GET /api/v1/projects/:slug/designs/:issue`: the manifest. */
export function designManifestUrlOf(slug: string, issue: number): string {
  return `/api/v1/projects/${encodeURIComponent(slug)}/designs/${issue}`;
}

/**
 * `GET /api/v1/projects/:slug/designs/:issue/:sha/file?path=…`: one screen's bytes. The console puts this in an
 * `<img src>`; the Worker answers only for a path in the manifest at that commit.
 */
export function designFileUrlOf(slug: string, issue: number, sha: string, path: string): string {
  return `${designManifestUrlOf(slug, issue)}/${encodeURIComponent(sha)}/file?path=${encodeURIComponent(path)}`;
}
