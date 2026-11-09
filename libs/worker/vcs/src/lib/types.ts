import type { SprintCiState } from '@shared/contracts';

/**
 * Provider-neutral repository-side types (ADR 0006 "VCS adapter"): "pull request" covers a GitLab merge request.
 * Nothing here is a provider's raw shape; every adapter narrows its provider's JSON into these.
 */

export type VcsProvider = 'github' | 'gitlab';

/**
 * A repository as the registry knows it. `owner`/`name` build the provider's paths (never a client-chosen string);
 * `externalId` is the provider's repository id when the registry recorded one (`projects.repo_id`), so a renamed
 * or transferred repository is never read in its place.
 */
export interface RepoRef {
  readonly provider: VcsProvider;
  readonly owner: string;
  readonly name: string;
  readonly externalId: string | null;
}

export interface Repository {
  readonly externalId: string;
  /** `owner/name` as the provider spells it now. */
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly visibility: 'public' | 'private';
  readonly htmlUrl: string;
}

export interface Branch {
  readonly name: string;
  /** The head commit, 40 lower-case hex. */
  readonly sha: string;
  readonly protected: boolean;
}

/** One page of a list; `nextPage` is the page to ask for next, `null` at the end. */
export interface Page<T> {
  readonly items: readonly T[];
  readonly nextPage: number | null;
}

export interface PageOpts {
  /** 1-based. */
  readonly page?: number;
  /** At most 100 (the providers' page cap). */
  readonly perPage?: number;
}

export interface FileContent {
  readonly path: string;
  /** The blob's object id. */
  readonly sha: string;
  readonly size: number;
  readonly bytes: Uint8Array;
  /** The bytes as UTF-8, `null` when they are not valid UTF-8. */
  readonly text: string | null;
}

export type PullRequestState = 'open' | 'closed' | 'merged';

export const PULL_REQUEST_STATES: readonly PullRequestState[] = ['open', 'closed', 'merged'];

export function isPullRequestState(value: unknown): value is PullRequestState {
  return typeof value === 'string' && (PULL_REQUEST_STATES as readonly string[]).includes(value);
}

export interface PullRequest {
  /** The provider's id of the pull request (stable across renames of its branch). */
  readonly externalId: string;
  readonly number: number;
  /** As the provider sends it: untrusted text, cleaned only where it is shown. */
  readonly title: string;
  readonly state: PullRequestState;
  readonly draft: boolean;
  readonly headRef: string;
  readonly headSha: string;
  readonly baseRef: string;
  /** `owner/name` of the head's repository, `null` when the provider names none (a deleted fork). */
  readonly headRepository: string | null;
  readonly authorLogin: string | null;
  /** The pull request's page, built by the adapter from the repository and number, never taken from a payload. */
  readonly url: string;
  /** The provider's last change, ISO 8601 UTC (`2026-11-09T10:00:00Z`): orders deliveries that race. */
  readonly updatedAt: string;
}

export type ChangedFileStatus =
  'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';

export interface ChangedFile {
  readonly path: string;
  /** The path before a rename or copy, else `null`. */
  readonly previousPath: string | null;
  readonly status: ChangedFileStatus;
  readonly additions: number;
  readonly deletions: number;
}

/** A head commit's CI, summarised as the board shows it (#131): the shared `SprintCiState` set. */
export type CiState = SprintCiState;

export type MergeMethod = 'merge' | 'squash' | 'rebase';

export interface MergeResult {
  readonly sha: string;
}

export interface ScopedToken {
  readonly token: string;
  readonly expiresAt: string;
}

export interface VcsCapabilities {
  readonly mergeMethods: readonly MergeMethod[];
  readonly draft: boolean;
  readonly checkRuns: boolean;
  /** The largest file `files.read` can return inline, in bytes. */
  readonly fileSizeLimit: number;
}

export interface VcsRepositoryOfEvent {
  readonly externalId: string;
  readonly fullName: string;
}

export type PullRequestEventKind =
  | 'pr.opened'
  | 'pr.reopened'
  | 'pr.synchronize'
  | 'pr.edited'
  | 'pr.ready'
  | 'pr.draft'
  | 'pr.closed'
  | 'pr.merged';

/**
 * A delivery normalised (ADR 0006 "VCS adapter"). Only what the `hooks` Worker acts on: pull request changes, a
 * finished CI run and a push. Installation events stay the hooks Worker's own (ADR 0003 decision 5).
 */
export type VcsEvent =
  | {
      readonly kind: PullRequestEventKind;
      readonly repository: VcsRepositoryOfEvent;
      readonly installationId: number | null;
      readonly pullRequest: PullRequest;
    }
  | {
      readonly kind: 'ci.completed';
      readonly repository: VcsRepositoryOfEvent;
      readonly installationId: number | null;
      readonly sha: string;
    }
  | {
      readonly kind: 'push';
      readonly repository: VcsRepositoryOfEvent;
      readonly installationId: number | null;
      /** The full ref, e.g. `refs/heads/main`. */
      readonly ref: string;
    };

/** A delivery as the hooks Worker read it: the event name header and the JSON body, already signature-checked. */
export interface VcsDelivery {
  readonly event: string;
  readonly payload: unknown;
}
