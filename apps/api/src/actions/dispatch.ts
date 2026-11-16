import { ACTIONS_DISPATCH_FAILED, type ActionsDispatchFailure } from '@shared/contracts';
import type { Logger } from '@worker/core';
import { JobsRepo, ProjectDispatchRepo } from '@worker/db';
import {
  GitHubClient,
  GitHubError,
  InvalidRepoNameError,
  dispatchRunnerWorkflow,
  githubPath,
  parseRepoName,
  type RepoName,
} from '@worker/github';
import type { ApiEnv } from '../env';
import type { ApiGitHub } from '../github';

/**
 * Dispatch to GitHub Actions (#670; architect note on #573 section 1, ADR 0008 decision 7(a′)). For each queued
 * Actions job: read the repository by its registered name and require GitHub's `id` to be `projects.repo_id`, take
 * its `default_branch` from that answer (never from input, and refreshed on every dispatch so a renamed default
 * branch is picked up, #695 item 4), mint a one-repository `actions: write` token through the project's own
 * installation (linked to the project's account, so a project never dispatches into another account's repository),
 * call `workflow_dispatch` with `{ ref: default_branch, inputs: { job_id } }` and record `dispatched_at`. A failed
 * call fails the job with `metrics.reason = 'dispatch-failed'` and a fixed summary; the token is used once and never
 * stored or logged.
 */

export interface DispatchDeps {
  readonly env: ApiEnv;
  readonly github: ApiGitHub;
  readonly logger: Logger;
  readonly now?: () => Date;
}

export type DispatchOutcome =
  | { readonly kind: 'dispatched' }
  | { readonly kind: 'failed'; readonly failure: ActionsDispatchFailure }
  /** Not a queued, undispatched Actions job (a pull job, or one another request already dispatched or ended). */
  | { readonly kind: 'skipped' };

interface RepositoryAnswer {
  readonly id: number;
  readonly full_name: string;
  readonly default_branch: string;
}

function isRepositoryAnswer(value: unknown): value is RepositoryAnswer {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record['id'] === 'number' &&
    typeof record['full_name'] === 'string' &&
    typeof record['default_branch'] === 'string' &&
    record['default_branch'] !== ''
  );
}

type Phase = 'read' | 'mint' | 'dispatch';

/** Which fixed phrase a GitHub refusal is put down to; GitHub's own text never reaches the job or a log. */
export function dispatchFailureOf(phase: Phase, error: GitHubError): ActionsDispatchFailure {
  const status = error.githubStatus;
  if (error.problem.type === 'github-unavailable' || error.problem.type === 'github-rate-limit') {
    return 'github unavailable';
  }
  switch (phase) {
    case 'read':
      return status === 404 ? 'repository mismatch' : 'github error';
    case 'mint':
      // GitHub answers 422 to a mint asking for a permission the installation was not granted.
      if (status === 422) {
        return 'permission missing';
      }
      return status === 404 ? 'installation missing' : 'github error';
    case 'dispatch':
      if (status === 403) {
        return 'permission missing';
      }
      return status === 404 ? 'workflow missing' : 'github error';
  }
}

class DispatchRefusal extends Error {
  constructor(readonly failure: ActionsDispatchFailure) {
    super(failure);
    this.name = 'DispatchRefusal';
  }
}

export async function dispatchActionsJob(deps: DispatchDeps, jobId: string): Promise<DispatchOutcome> {
  const jobs = new JobsRepo(deps.env.DB);
  const target = await jobs.findDispatchTarget(jobId);
  if (target === null) {
    return { kind: 'skipped' };
  }
  const slug = target.job.projectSlug;
  let phase: Phase = 'read';
  try {
    if (target.installationId === null) {
      throw new DispatchRefusal('installation missing');
    }
    if (target.repoId === null) {
      throw new DispatchRefusal('repository mismatch');
    }
    const registered = parseRepoName(target.repo);
    const { auth, fetch } = await deps.github.connect(deps.env);
    const read = await new GitHubClient(fetch, auth.tokenSourceFor(registered)).getJson(
      githubPath`/repos/${registered}`,
      isRepositoryAnswer,
    );
    if (read.id !== target.repoId) {
      throw new DispatchRefusal('repository mismatch');
    }
    // GitHub's current name: a POST does not follow the redirect a renamed repository answers with.
    const current: RepoName = parseRepoName(read.full_name);
    await new ProjectDispatchRepo(deps.env.DB).recordDefaultBranch(slug, read.default_branch);
    phase = 'mint';
    const token = await auth.mintForActionsDispatch(target.installationId, target.repoId);
    // Recorded before the call, as a compare-and-set: a second request never dispatches the job again, and a run
    // that boots fast never meets a job the exchange still refuses as undispatched (#695 item 3).
    if (!(await jobs.markDispatched(jobId, (deps.now?.() ?? new Date()).toISOString()))) {
      deps.logger.warn('actions dispatch not recorded', { jobId, slug });
      return { kind: 'skipped' };
    }
    phase = 'dispatch';
    await dispatchRunnerWorkflow(fetch, token, current, read.default_branch, jobId);
  } catch (error: unknown) {
    const failure =
      error instanceof DispatchRefusal
        ? error.failure
        : error instanceof InvalidRepoNameError
          ? 'repository mismatch'
          : error instanceof GitHubError
            ? dispatchFailureOf(phase, error)
            : null;
    if (failure === null) {
      throw error;
    }
    deps.logger.warn('actions dispatch failed', {
      jobId,
      slug,
      phase,
      failure,
      ...(error instanceof GitHubError ? { githubStatus: error.githubStatus } : {}),
    });
    const at = (deps.now?.() ?? new Date()).toISOString();
    await jobs.failUndispatched(jobId, at, ACTIONS_DISPATCH_FAILED, `${ACTIONS_DISPATCH_FAILED}: ${failure}`);
    return { kind: 'failed', failure };
  }
  deps.logger.info('actions job dispatched', { jobId, slug });
  return { kind: 'dispatched' };
}

/** Every Actions job of `jobs` in turn; pull jobs are skipped. */
export async function dispatchActionsJobs(
  deps: DispatchDeps,
  jobs: readonly { readonly id: string; readonly dispatch: string }[],
): Promise<void> {
  for (const job of jobs) {
    if (job.dispatch === 'actions') {
      await dispatchActionsJob(deps, job.id);
    }
  }
}
