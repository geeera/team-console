import type {
  Branch,
  ChangedFile,
  CiState,
  FileContent,
  MergeMethod,
  MergeResult,
  Page,
  PageOpts,
  PullRequest,
  RepoRef,
  Repository,
  ScopedToken,
  VcsCapabilities,
  VcsDelivery,
  VcsEvent,
  VcsProvider,
} from './types';

export type PullRequestListState = 'open' | 'closed' | 'all';

/**
 * The provider's webhooks, apart from the adapter so the `hooks` Worker can use them without any VCS credential
 * (threat model C6: the hooks Worker never holds an app key).
 */
export interface VcsWebhooks {
  /**
   * Whether `signature` (the provider's signature header) signs exactly `body` with one of `secrets` (the current
   * one, then the previous one during a rotation). Constant-time; a malformed header is `false`, never a throw.
   */
  verify(
    body: ArrayBuffer,
    signature: string | null | undefined,
    secrets: readonly string[],
  ): Promise<boolean>;
  /** The delivery normalised, or `null` for one the console does not act on. Pure: no I/O. */
  parse(delivery: VcsDelivery): VcsEvent | null;
}

/**
 * VCS access (ADR 0006 decision 7, "VCS adapter"; ADR 0008 row 3a). Every read is budgeted by the transport the
 * adapter was built with and throws `VcsError`; paths are built from `RepoRef` only. Writes are part of the
 * interface so callers are written against it once, and refuse with 403 `vcs-write-forbidden` until #309 3b.
 */
export interface VcsAdapter {
  readonly provider: VcsProvider;
  capabilities(): VcsCapabilities;
  /** `not-found` when the repository is gone, out of the token's reach, or no longer has `ref.externalId`. */
  repository(ref: RepoRef): Promise<Repository>;
  readonly branches: {
    get(ref: RepoRef, name: string): Promise<Branch | null>;
    list(ref: RepoRef, opts?: PageOpts): Promise<Page<Branch>>;
  };
  readonly files: {
    /** `max` bytes at most; a directory or a missing path is `not-found`. */
    read(
      ref: RepoRef,
      path: string,
      revision: string,
      max: number,
    ): Promise<FileContent | 'not-found' | 'too-large'>;
  };
  readonly pullRequests: {
    get(ref: RepoRef, number: number): Promise<PullRequest | null>;
    list(
      ref: RepoRef,
      filter: { readonly state: PullRequestListState; readonly base?: string },
      opts?: PageOpts,
    ): Promise<Page<PullRequest>>;
    files(ref: RepoRef, number: number, opts?: PageOpts): Promise<Page<ChangedFile>>;
    create(
      ref: RepoRef,
      input: {
        readonly head: string;
        readonly base: string;
        readonly title: string;
        readonly body: string;
        readonly draft?: boolean;
      },
    ): Promise<PullRequest>;
    /** Merges the base into the head, never a force push. */
    updateBranch(ref: RepoRef, number: number): Promise<void>;
    comment(ref: RepoRef, number: number, body: string): Promise<void>;
    merge(
      ref: RepoRef,
      number: number,
      input: { readonly method: MergeMethod; readonly expectedHeadSha: string; readonly title?: string },
    ): Promise<MergeResult>;
  };
  readonly ci: {
    status(ref: RepoRef, sha: string): Promise<CiState>;
  };
  readonly webhooks: VcsWebhooks;
  readonly credentials: {
    gitToken(ref: RepoRef, scope: 'read' | 'write', ttlSeconds: number): Promise<ScopedToken>;
  };
}
