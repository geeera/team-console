import {
  DESIGN_IMAGE_MAX_BYTES,
  type DesignImageType,
  type DesignManifestDto,
  type DesignRefKind,
} from '@shared/contracts';
import type { ProjectRow } from '@worker/db';
import { GitHubError, githubPath, readCacheKey, type RepoName } from '@worker/github';
import {
  designFilesOf,
  designManifestOf,
  imageTypeOfBytes,
  isGitHubTree,
  linkingPullRequestOf,
  screenCaptionsOf,
  screensJsonOf,
  treeListingOf,
  type TreeEntry,
  type TreeListing,
} from '@worker/read-models';
import type { ApiEnv } from '../env';
import type { ApiGitHub } from '../github';
import type { ProjectReads } from './project-reads';

/** A commit's tree never changes, but the cache is memory: 600 s keeps a busy list cheap without pinning it forever. */
const TREE_TTL_SECONDS = 600;
/** The default branch moves with every merge: 60 s, like the other list reads. */
const BRANCH_TTL_SECONDS = 60;
/** The repository's default branch name changes about never. */
const REPOSITORY_TTL_SECONDS = 600;

const RAW_MEDIA_TYPE = 'application/vnd.github.raw+json';

type JsonRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRepositoryAnswer(value: unknown): value is { default_branch: string } {
  return isRecord(value) && typeof value['default_branch'] === 'string' && value['default_branch'] !== '';
}

const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function isBranchAnswer(value: unknown): value is { commit: { sha: string } } {
  return (
    isRecord(value) &&
    isRecord(value['commit']) &&
    typeof value['commit']['sha'] === 'string' &&
    COMMIT_SHA.test(value['commit']['sha'])
  );
}

interface DesignRef {
  readonly sha: string;
  readonly kind: DesignRefKind;
}

/**
 * What one commit holds for one issue: the manifest (without the ref kind, which is the caller's knowledge) and the
 * blob sha of each file, which the DTO does not carry.
 */
interface DiscoveredDesign {
  readonly manifest: Omit<DesignManifestDto, 'ref'>;
  readonly blobs: Readonly<Record<string, string>>;
}

export type DesignFileResult =
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array; readonly type: DesignImageType; readonly file: string }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'too-large' }
  | { readonly kind: 'type-mismatch' };

/**
 * The design viewer's reads (#277, spec §R): which commit a design issue's files live at, the manifest at that commit
 * and one file's bytes, all with the project's read-only installation token, so private repositories work and the
 * token never reaches the client.
 *
 * Subrequests, cold isolate and empty cache (a cached installation token saves the first two):
 *   manifest = lookup 1 + mint 1 + open pulls 1 + (repository 1 + branch 1 when no pull request links the issue)
 *              + tree 1 + screens.json ≤ 1                                          → ≤ 7
 *   file     = lookup 1 + mint 1 + (tree 1 + screens.json ≤ 1 when the manifest is not cached) + blob 1 → ≤ 5
 */
export class DesignReads {
  constructor(
    private readonly github: ApiGitHub,
    private readonly env: ApiEnv,
    private readonly project: ProjectRow,
    private readonly repo: RepoName,
    private readonly reads: ProjectReads,
  ) {}

  /** The manifest at the issue's current commit: the linking open pull request's head, else the default branch. */
  async manifest(issue: number): Promise<DesignManifestDto> {
    const ref = await this.refOf(issue);
    return { ...(await this.discover(issue, ref.sha)).manifest, ref: ref.kind };
  }

  /**
   * One screen's bytes at a commit the client got from a manifest. The path must be a screen of the manifest at that
   * commit (never a path the client made up: a tree never lists `..`, and only png/jpeg/webp/gif files are screens),
   * the manifest must not have marked it too large, and the bytes must announce the type the name claims.
   */
  async file(issue: number, sha: string, path: string): Promise<DesignFileResult> {
    const { manifest, blobs } = await this.discover(issue, sha);
    const screen = manifest.screens.find((candidate) => candidate.path === path);
    const blob = blobs[path];
    if (screen === undefined || blob === undefined) {
      return { kind: 'not-found' };
    }
    if (screen.tooLarge) {
      return { kind: 'too-large' };
    }
    const client = await this.reads.connect();
    const read = await client.getBytes(githubPath`/repos/${this.repo}/git/blobs/${blob}`, {
      accept: RAW_MEDIA_TYPE,
      maxBytes: DESIGN_IMAGE_MAX_BYTES,
    });
    if (read.kind === 'too-large') {
      return { kind: 'too-large' };
    }
    if (imageTypeOfBytes(read.bytes) !== screen.type) {
      return { kind: 'type-mismatch' };
    }
    return { kind: 'bytes', bytes: read.bytes, type: screen.type, file: screen.file };
  }

  private async refOf(issue: number): Promise<DesignRef> {
    const pulls = await this.reads.openPullRequests();
    const linking = linkingPullRequestOf(pulls, issue);
    if (linking?.headSha !== null && linking?.headSha !== undefined) {
      return { sha: linking.headSha, kind: 'pull-request' };
    }
    const branch = await this.cached('repository', REPOSITORY_TTL_SECONDS, async () => {
      const client = await this.reads.connect();
      return (await client.getJson(githubPath`/repos/${this.repo}`, isRepositoryAnswer)).default_branch;
    });
    const sha = await this.cached(`branch-head-${branch}`, BRANCH_TTL_SECONDS, async () => {
      const client = await this.reads.connect();
      return (await client.getJson(githubPath`/repos/${this.repo}/branches/${branch}`, isBranchAnswer)).commit
        .sha;
    });
    return { sha, kind: 'default-branch' };
  }

  /** Keyed by issue and commit: a client holding a manifest's sha gets the same set the manifest listed. */
  private discover(issue: number, sha: string): Promise<DiscoveredDesign> {
    return this.cached(`design-${issue}-${sha}`, TREE_TTL_SECONDS, async () => {
      const listing = await this.tree(sha);
      const files = designFilesOf(listing, issue);
      const captions = await this.captionsOf(files.files);
      const { ref: _ref, ...manifest } = designManifestOf({
        issue,
        sha,
        ref: 'pull-request',
        files,
        truncated: listing.truncated,
        captions,
        repo: this.repo,
      });
      const blobs: Record<string, string> = {};
      for (const file of files.files) {
        blobs[file.path] = file.sha;
      }
      return { manifest, blobs: blobs as Readonly<Record<string, string>> };
    });
  }

  private tree(sha: string): Promise<TreeListing> {
    return this.cached(`tree-${sha}`, TREE_TTL_SECONDS, async () => {
      const client = await this.reads.connect();
      const answer = await client.getJson(
        githubPath`/repos/${this.repo}/git/trees/${sha}?recursive=${1}`,
        isGitHubTree,
      );
      return treeListingOf(answer);
    });
  }

  /** `screens.json` beside the screens; one that cannot be read costs its captions only, never the manifest. */
  private async captionsOf(files: readonly TreeEntry[]): Promise<ReadonlyMap<string, string>> {
    const entry = screensJsonOf(files);
    if (entry === null) {
      return new Map();
    }
    try {
      const client = await this.reads.connect();
      const read = await client.getBytes(githubPath`/repos/${this.repo}/git/blobs/${entry.sha}`, {
        accept: RAW_MEDIA_TYPE,
        maxBytes: entry.size,
      });
      return read.kind === 'bytes' ? screenCaptionsOf(new TextDecoder().decode(read.bytes)) : new Map();
    } catch (error: unknown) {
      if (error instanceof GitHubError) {
        return new Map();
      }
      throw error;
    }
  }

  private cached<T>(type: string, ttlSeconds: number, fill: () => Promise<T>): Promise<T> {
    const key = readCacheKey({
      environment: this.env.ENVIRONMENT,
      slug: this.project.slug,
      epoch: this.project.cache_epoch,
      type,
    });
    return this.github.readCache.getOrFill(key, ttlSeconds, fill);
  }
}
