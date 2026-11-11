import {
  GitHubClient,
  githubContentsPath,
  githubPath,
  githubUnexpectedError,
  parseRepoName,
  type FetchLike,
  type GitHubPath,
  type InstallationTokenSource,
  type JsonGuard,
  type RepoName,
} from '@worker/github';
import { checkRunsPageOf, ciStateOf, isGitHubCheckRunsPage } from '@worker/read-models';
import {
  VcsError,
  vcsWriteForbidden,
  type Branch,
  type ChangedFile,
  type CiState,
  type FileContent,
  type MergeMethod,
  type Page,
  type PageOpts,
  type PullRequest,
  type PullRequestListState,
  type RepoRef,
  type Repository,
  type VcsAdapter,
  type VcsCapabilities,
} from '@worker/vcs';
import { orNull, translated } from './errors';
import {
  branchOf,
  changedFileOf,
  isBranchName,
  isCommitSha,
  isRecord,
  pullRequestOf,
  repositoryOf,
} from './records';
import { githubWebhooks } from './webhooks';

/** The contents API answers files up to 1 MB inline; larger ones come without content. */
export const CONTENTS_INLINE_MAX_BYTES = 1024 * 1024;
const DEFAULT_PER_PAGE = 30;
const MAX_PER_PAGE = 100;

/**
 * What the adapter reads through: the transport (the caller's `SubrequestBudget` counts it) and the app's
 * per-repository, read-only token minting (`GitHubAppAuth.tokenSourceFor`, ADR 0003 decision 6).
 */
export interface GitHubVcsConnection {
  readonly fetch: FetchLike;
  readonly auth: { tokenSourceFor(repo: RepoName): InstallationTokenSource };
}

const CAPABILITIES: VcsCapabilities = Object.freeze({
  mergeMethods: Object.freeze(['merge', 'squash', 'rebase'] as const),
  draft: true,
  checkRuns: true,
  fileSizeLimit: CONTENTS_INLINE_MAX_BYTES,
});

function pageOf(opts: PageOpts | undefined): { page: number; perPage: number } {
  const page = opts?.page ?? 1;
  const perPage = opts?.perPage ?? DEFAULT_PER_PAGE;
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isSafeInteger(perPage) ||
    perPage < 1 ||
    perPage > MAX_PER_PAGE
  ) {
    throw new RangeError('page is a positive integer and perPage 1..100');
  }
  return { page, perPage };
}

function assertNumber(number: number): void {
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new RangeError('a pull request number is a positive integer');
  }
}

/** A guard over GitHub's item that the mapper accepts; the mapper runs again on the narrowed value. */
function mappable<T>(map: (raw: unknown) => T | null): JsonGuard<unknown> {
  return (value: unknown): value is unknown => map(value) !== null;
}

function mapped<T>(raw: unknown, map: (raw: unknown) => T | null, status: number | null = 200): T {
  const value = map(raw);
  if (value === null) {
    throw githubUnexpectedError('GitHub returned an item of an unexpected shape', status);
  }
  return value;
}

function base64Bytes(content: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(content.replace(/\s/g, '')), (char) => char.charCodeAt(0));
  } catch (error: unknown) {
    if (error instanceof DOMException || error instanceof TypeError) {
      return null;
    }
    throw error;
  }
}

function utf8Of(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch (error: unknown) {
    if (error instanceof TypeError) {
      return null;
    }
    throw error;
  }
}

/**
 * The GitHub `VcsAdapter` (ADR 0006 decision 7, ADR 0008 row 3a) over `GitHubClient` and the app's read-only
 * installation tokens: one client per repository, paths built with `githubPath` from the validated `RepoRef`, and
 * list reads one page at a time (`page`/`per_page` queries we build, never a `Link` URL followed). Writes refuse
 * with 403 `vcs-write-forbidden` before any request until #309 3b.
 */
export class GitHubVcsAdapter implements VcsAdapter {
  readonly provider = 'github';
  readonly webhooks = githubWebhooks;
  private readonly clients = new Map<string, GitHubClient>();

  constructor(private readonly connection: GitHubVcsConnection) {}

  capabilities(): VcsCapabilities {
    return CAPABILITIES;
  }

  async repository(ref: RepoRef): Promise<Repository> {
    const repo = this.repoNameOf(ref);
    return translated(async () => {
      const raw = await this.client(repo).getJson(githubPath`/repos/${repo}`, isRecord);
      const repository = mapped(raw, repositoryOf);
      // A rename or a transfer leaves the name pointing at another repository: the registry's id decides.
      if (ref.externalId !== null && repository.externalId !== ref.externalId) {
        throw new VcsError('conflict', {
          type: 'vcs-repository-changed',
          title: 'The repository is not the registered one',
          status: 409,
          detail: 'The name now points at a repository with another id',
        });
      }
      return repository;
    });
  }

  readonly branches = {
    get: async (ref: RepoRef, name: string): Promise<Branch | null> => {
      const repo = this.repoNameOf(ref);
      if (!isBranchName(name)) {
        return null;
      }
      return translated(() =>
        orNull(async () =>
          mapped(
            await this.client(repo).getJson(githubPath`/repos/${repo}/branches/${name}`, isRecord),
            branchOf,
          ),
        ),
      );
    },
    list: async (ref: RepoRef, opts?: PageOpts): Promise<Page<Branch>> => {
      const repo = this.repoNameOf(ref);
      const { page, perPage } = pageOf(opts);
      return this.page(
        repo,
        githubPath`/repos/${repo}/branches?per_page=${perPage}&page=${page}`,
        page,
        branchOf,
      );
    },
  };

  readonly files = {
    read: async (
      ref: RepoRef,
      path: string,
      revision: string,
      max: number,
    ): Promise<FileContent | 'not-found' | 'too-large'> => {
      const repo = this.repoNameOf(ref);
      if (!isBranchName(revision)) {
        throw new RangeError('a revision is a branch, a tag or a commit');
      }
      if (!Number.isSafeInteger(max) || max < 0) {
        throw new RangeError('max is a non-negative integer');
      }
      // Built before the request: a traversal or an empty segment is the caller's bug, never a GitHub read.
      const contentsPath = githubContentsPath(repo, path, revision);
      const raw = await translated(() =>
        orNull(() => this.client(repo).getJson(contentsPath, isContentsAnswer)),
      );
      if (raw === null || Array.isArray(raw) || raw['type'] !== 'file') {
        return 'not-found';
      }
      const size = raw['size'];
      const sha = raw['sha'];
      if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || typeof sha !== 'string') {
        throw new VcsError('unavailable', {
          type: 'github-unexpected',
          title: 'Unexpected answer from GitHub',
          status: 502,
          detail: 'GitHub returned a file of an unexpected shape',
        });
      }
      if (size > Math.min(max, CONTENTS_INLINE_MAX_BYTES)) {
        return 'too-large';
      }
      const content = raw['content'];
      // A file GitHub did not inline (over its limit) has `encoding: none` and an empty content.
      if (raw['encoding'] !== 'base64' || typeof content !== 'string') {
        return 'too-large';
      }
      const bytes = base64Bytes(content);
      if (bytes === null || bytes.byteLength !== size) {
        throw new VcsError('unavailable', {
          type: 'github-unexpected',
          title: 'Unexpected answer from GitHub',
          status: 502,
          detail: 'GitHub returned file content that does not decode to its size',
        });
      }
      return { path, sha, size, bytes, text: utf8Of(bytes) };
    },
  };

  readonly pullRequests = {
    get: async (ref: RepoRef, number: number): Promise<PullRequest | null> => {
      const repo = this.repoNameOf(ref);
      assertNumber(number);
      return translated(() =>
        orNull(async () => {
          const raw = await this.client(repo).getJson(githubPath`/repos/${repo}/pulls/${number}`, isRecord);
          return mapped(raw, (value) => pullRequestOf(value, repo.fullName));
        }),
      );
    },
    list: async (
      ref: RepoRef,
      filter: { readonly state: PullRequestListState; readonly base?: string },
      opts?: PageOpts,
    ): Promise<Page<PullRequest>> => {
      const repo = this.repoNameOf(ref);
      const { page, perPage } = pageOf(opts);
      if (filter.base !== undefined && !isBranchName(filter.base)) {
        throw new RangeError('base is a branch name');
      }
      const state = filter.state;
      const path =
        filter.base === undefined
          ? githubPath`/repos/${repo}/pulls?state=${state}&per_page=${perPage}&page=${page}`
          : githubPath`/repos/${repo}/pulls?state=${state}&base=${filter.base}&per_page=${perPage}&page=${page}`;
      return this.page(repo, path, page, (value) => pullRequestOf(value, repo.fullName));
    },
    files: async (ref: RepoRef, number: number, opts?: PageOpts): Promise<Page<ChangedFile>> => {
      const repo = this.repoNameOf(ref);
      assertNumber(number);
      const { page, perPage } = pageOf(opts);
      return this.page(
        repo,
        githubPath`/repos/${repo}/pulls/${number}/files?per_page=${perPage}&page=${page}`,
        page,
        changedFileOf,
      );
    },
    // Unused params kept on the stubs below (not `()`) so this object's inferred type still matches
    // VcsAdapter's full method signatures — callers can be typechecked against the real interface, not a
    // narrower one `implements` happens to allow structurally.
    create: async (
      _ref: RepoRef,
      _input: { readonly head: string; readonly base: string; readonly title: string; readonly body: string; readonly draft?: boolean },
    ): Promise<PullRequest> => {
      throw vcsWriteForbidden('pullRequests.create');
    },
    updateBranch: async (_ref: RepoRef, _number: number): Promise<void> => {
      throw vcsWriteForbidden('pullRequests.updateBranch');
    },
    comment: async (_ref: RepoRef, _number: number, _body: string): Promise<void> => {
      throw vcsWriteForbidden('pullRequests.comment');
    },
    merge: async (
      _ref: RepoRef,
      _number: number,
      _input: { readonly method: MergeMethod; readonly expectedHeadSha: string; readonly title?: string },
    ): Promise<never> => {
      throw vcsWriteForbidden('pullRequests.merge');
    },
  };

  readonly ci = {
    /** The head's latest check runs (#131's one read), summarised by `ciStateOf` of `@worker/read-models`. */
    status: async (ref: RepoRef, sha: string): Promise<CiState> => {
      const repo = this.repoNameOf(ref);
      if (!isCommitSha(sha)) {
        throw new RangeError('a commit sha is 40 lower-case hex');
      }
      return translated(async () => {
        const raw = await this.client(repo).getJson(
          githubPath`/repos/${repo}/commits/${sha}/check-runs?filter=latest&per_page=${100}`,
          isGitHubCheckRunsPage,
        );
        return ciStateOf(checkRunsPageOf(raw));
      });
    },
  };

  readonly credentials = {
    gitToken: async (_ref: RepoRef, _scope: 'read' | 'write', _ttlSeconds: number): Promise<never> => {
      throw vcsWriteForbidden('credentials.gitToken');
    },
  };

  private repoNameOf(ref: RepoRef): RepoName {
    if (ref.provider !== 'github') {
      throw new TypeError('the GitHub adapter reads GitHub repositories only');
    }
    return parseRepoName(`${ref.owner}/${ref.name}`);
  }

  private client(repo: RepoName): GitHubClient {
    const key = repo.fullName.toLowerCase();
    let client = this.clients.get(key);
    if (client === undefined) {
      client = new GitHubClient(this.connection.fetch, this.connection.auth.tokenSourceFor(repo));
      this.clients.set(key, client);
    }
    return client;
  }

  /**
   * One page of a list; GitHub's `Link: rel="next"` says only whether there is another, it is never followed. A next
   * link off api.github.com is `github-unexpected`, never "the last page": a caller deciding that a row it no longer
   * sees is closed must not decide it on a list GitHub said goes on (#481).
   */
  private async page<T>(
    repo: RepoName,
    path: GitHubPath,
    page: number,
    map: (raw: unknown) => T | null,
  ): Promise<Page<T>> {
    return translated(async () => {
      const read = await this.client(repo).paginateBounded(path, mappable(map), {
        maxPages: 1,
        unfollowableNext: 'unexpected',
      });
      return { items: read.items.map((raw) => mapped(raw, map)), nextPage: read.complete ? null : page + 1 };
    });
  }
}

function isContentsAnswer(value: unknown): value is Readonly<Record<string, unknown>> | unknown[] {
  return Array.isArray(value) || isRecord(value);
}
