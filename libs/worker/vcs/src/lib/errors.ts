import type { MappedError, ProblemInit } from '@worker/core';

/** ADR 0006 "VCS adapter": the one error model every adapter method throws. */
export type VcsErrorKind =
  'not-found' | 'forbidden' | 'rate-limited' | 'conflict' | 'unavailable' | 'too-large';

/**
 * A VCS call that cannot be answered. `problem` is what the Worker answers (an adapter keeps its provider's problem
 * types, e.g. `github-rate-limit`, so clients keep branching on them); `providerStatus` goes to the log only. The
 * message is the problem title and never holds a token, a URL or the provider's body.
 */
export class VcsError extends Error {
  constructor(
    readonly kind: VcsErrorKind,
    readonly problem: ProblemInit,
    readonly providerStatus: number | null = null,
  ) {
    super(problem.title);
    this.name = 'VcsError';
  }

  /** Seconds to wait, for `rate-limited`. */
  get retryAfter(): number | null {
    return this.problem.retryAfter ?? null;
  }
}

export type VcsWriteOperation =
  | 'pullRequests.create'
  | 'pullRequests.updateBranch'
  | 'pullRequests.comment'
  | 'pullRequests.merge'
  | 'credentials.gitToken';

/**
 * 403 `vcs-write-forbidden`: repository writes arrive with #309 3b (per-job tokens, the gate status, console merge),
 * after the owner's `access` decision on the app's permissions. Until then every write is refused before any request.
 */
export function vcsWriteForbidden(operation: VcsWriteOperation): VcsError {
  return new VcsError('forbidden', {
    type: 'vcs-write-forbidden',
    title: 'Repository writes are not enabled',
    status: 403,
    detail: `${operation} is not available yet`,
  });
}

/** `createWorkerApp`'s `mapError` for a `VcsError`: its problem, the provider's status to the log. */
export function mapVcsError(error: unknown): MappedError | undefined {
  if (!(error instanceof VcsError)) {
    return undefined;
  }
  return { problem: error.problem, logFields: { vcsKind: error.kind, providerStatus: error.providerStatus } };
}
