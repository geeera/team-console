import { ACTIONS_NOT_READY, isGitHubUiUrl, type ActionsSetupItemId } from '@shared/contracts';
import { problem, type ProblemExtensionValue, type WorkerContext } from '@worker/core';
import { RateLimitsRepo, rateWindowOf, retryAfterOf } from '@worker/db';
import type { ReadinessOutcome } from '../actions/readiness';
import type { WorkflowPrOutcome } from '../actions/workflow-pr';
import type { ApiEnv } from '../env';

type Context = WorkerContext<ApiEnv>;

/**
 * The answers the Actions setup routes share (#759): `GET …/actions-setup`, `GET …/actions-setup/workflow` and the
 * readiness refusal of `PUT …/dispatch {actions}`.
 */

/**
 * Every readiness check mints an `environment-read` token and makes up to a dozen GitHub calls, so checks are counted
 * per project, the page's re-checks and the switch together. 20 per 10 minutes is far above a person clicking Check
 * again, and bounds what a stolen owner session can make the console spend at GitHub.
 */
export const READINESS_CHECKS_PER_WINDOW = 20;
export const READINESS_WINDOW_SECONDS = 600;

/** 429 `rate-limited` once the project's checks of this window are spent, else `null`; counted before any GitHub call. */
export async function readinessRateRefusal(c: Context, slug: string, at: number): Promise<Response | null> {
  const window = rateWindowOf(at, READINESS_WINDOW_SECONDS);
  const hit = await new RateLimitsRepo(c.env.DB).hit(`project:${slug}:actions-readiness`, window, READINESS_CHECKS_PER_WINDOW);
  if (hit.allowed) {
    return null;
  }
  c.get('logger').warn('actions readiness rate limited', { slug });
  return problem(c, {
    type: 'rate-limited',
    title: 'Too Many Requests',
    status: 429,
    detail: `At most ${String(READINESS_CHECKS_PER_WINDOW)} readiness checks per ${String(READINESS_WINDOW_SECONDS / 60)} minutes for a project`,
    retryAfter: retryAfterOf(at, READINESS_WINDOW_SECONDS),
  });
}

export function originMisconfigured(c: Context, reason: string): Response {
  // The reason is a fixed enum; the configured and the request's origins stay out of the log and the answer.
  c.get('logger').error('runner workflow not rendered', { reason });
  return problem(c, {
    type: 'console-origin-misconfigured',
    title: 'The console cannot render its runner workflow',
    status: 503,
    detail: 'CONSOLE_PUBLIC_ORIGIN of this console is missing, malformed or not the origin it is served on',
  });
}

/** 422 `dispatch-repository-unverified`: the switch's and the check's word for a repository GitHub does not confirm. */
export function repositoryUnverified(c: Context, detail: string): Response {
  const extensions: Record<string, ProblemExtensionValue> = { field: 'dispatch' };
  return problem(c, { type: 'dispatch-repository-unverified', title: 'Invalid request', status: 422, detail, extensions });
}

/**
 * 422 `actions-not-ready` (security note row "Readiness used as authorisation"): the switch to `actions` is held back
 * until every blocking item is ok. `extensions.items` names them by id, in the page's order; nothing else of the check
 * rides along.
 */
export function actionsNotReady(c: Context, items: readonly ActionsSetupItemId[]): Response {
  const extensions: Record<string, ProblemExtensionValue> = { field: 'dispatch', items: [...items] };
  return problem(c, {
    type: ACTIONS_NOT_READY,
    title: 'GitHub Actions is not set up for this project yet',
    status: 422,
    detail: 'Finish the setup on the project’s GitHub Actions page, then switch again',
    extensions,
  });
}

/** The answer of an outcome that is not a checked readiness. */
export function uncheckedReadiness(c: Context, outcome: Exclude<ReadinessOutcome, { kind: 'checked' }>): Response {
  switch (outcome.kind) {
    case 'repository-unverified':
      return repositoryUnverified(c, outcome.detail);
    case 'console-misconfigured':
      return originMisconfigured(c, outcome.reason);
  }
}

/**
 * #759 PR 4 (security note row "Abuse of the write path"): opening the workflow pull request is counted per project
 * and per account, before any GitHub call. A person opens one PR per setup and one per runner release; 5 an hour for
 * a project and 20 an hour for an account leave room for a retry and bound the branches and pull requests a stolen
 * owner session can leave in a customer repository. (The counters are hourly: `rate_limits` keeps no longer window.)
 */
export const WORKFLOW_PR_PER_PROJECT = 5;
export const WORKFLOW_PR_PER_ACCOUNT = 20;
export const WORKFLOW_PR_WINDOW_SECONDS = 3600;
/**
 * Attempts across every account in one hour above which the Worker logs `actions setup write volume` at error level,
 * once per attempt past the threshold: the line the operator's alert is set on (docs/runbooks/deploy-and-rollback.md).
 * It refuses nothing: a cap shared by all accounts would let one of them switch the path off for the others.
 */
export const WORKFLOW_PR_VOLUME_ALERT = 30;

/** 429 `rate-limited` once the project's or the account's attempts of this hour are spent, else `null`. */
export async function workflowPrRateRefusal(c: Context, project: { readonly slug: string; readonly accountId: string }, at: number): Promise<Response | null> {
  const limits = new RateLimitsRepo(c.env.DB);
  const window = rateWindowOf(at, WORKFLOW_PR_WINDOW_SECONDS);
  const logger = c.get('logger');
  const refuse = (scope: 'project' | 'account', limit: number): Response => {
    logger.warn('actions workflow pr rate limited', { slug: project.slug, scope });
    return problem(c, {
      type: 'rate-limited',
      title: 'Too Many Requests',
      status: 429,
      detail: `At most ${String(limit)} workflow pull requests per hour for ${scope === 'project' ? 'a project' : 'an account'}`,
      retryAfter: retryAfterOf(at, WORKFLOW_PR_WINDOW_SECONDS),
    });
  };
  if (!(await limits.hit(`project:${project.slug}:actions-setup-pr`, window, WORKFLOW_PR_PER_PROJECT)).allowed) {
    return refuse('project', WORKFLOW_PR_PER_PROJECT);
  }
  if (!(await limits.hit(`account:${project.accountId}:actions-setup-pr`, window, WORKFLOW_PR_PER_ACCOUNT)).allowed) {
    return refuse('account', WORKFLOW_PR_PER_ACCOUNT);
  }
  const volume = await limits.hit('all:actions-setup-pr', window, WORKFLOW_PR_VOLUME_ALERT);
  if (!volume.allowed) {
    logger.error('actions setup write volume', { count: volume.count, threshold: WORKFLOW_PR_VOLUME_ALERT });
  }
  return null;
}

/** 503 `github-write-disabled`: the kill switch; the same problem the mint itself answers with the var off. */
function writeDisabled(c: Context): Response {
  c.get('logger').info('actions workflow pr refused', { reason: 'write-disabled' });
  return problem(c, {
    type: 'github-write-disabled',
    title: 'Writing to the repository is switched off on this console',
    status: 503,
    detail: 'The console does not open pull requests right now; add the workflow file yourself from its Copy view',
  });
}

/** The answer of every outcome of `openWorkflowPr` that opened no pull request. */
export function workflowPrRefusal(c: Context, outcome: Exclude<WorkflowPrOutcome, { kind: 'opened' }>): Response {
  switch (outcome.kind) {
    case 'write-disabled':
      return writeDisabled(c);
    case 'console-misconfigured':
      return originMisconfigured(c, outcome.reason);
    case 'repository-unverified':
      return problem(c, { type: 'dispatch-repository-unverified', title: 'Invalid request', status: 422, detail: outcome.detail });
    case 'permission-missing': {
      const extensions: Record<string, ProblemExtensionValue> = {
        permissions: [...outcome.permissions],
        ...(outcome.link !== null && isGitHubUiUrl(outcome.link) ? { link: outcome.link } : {}),
      };
      return problem(c, {
        type: 'actions-permission-missing',
        title: 'The app has not been granted the permissions to open a pull request',
        status: 422,
        detail: 'Accept the app’s updated permissions on GitHub, or add the workflow file yourself',
        extensions,
      });
    }
    case 'already-current':
      return problem(c, {
        type: 'actions-setup-ready',
        title: 'The workflow file is already this console’s',
        status: 422,
        detail: 'The file on the default branch equals the console’s rendering; there is nothing to open',
      });
    case 'downgrade': {
      const extensions: Record<string, ProblemExtensionValue> = { pins: [...outcome.pins] };
      return problem(c, {
        type: 'actions-setup-downgrade',
        title: 'The file on the default branch pins a newer version',
        status: 422,
        detail: 'The console never opens a pull request that lowers a pinned version',
        extensions,
      });
    }
    case 'pr-open': {
      const extensions: Record<string, ProblemExtensionValue> =
        outcome.pr === null ? {} : { number: outcome.pr.number, url: outcome.pr.url, provenance: outcome.pr.provenance };
      return problem(c, {
        type: 'actions-setup-pr-open',
        title: 'A pull request from the console’s branch is already open',
        status: 409,
        detail: 'Merge or close the open pull request first',
        extensions,
      });
    }
    case 'branch-exists': {
      const extensions: Record<string, ProblemExtensionValue> = { link: outcome.link };
      return problem(c, {
        type: 'actions-setup-branch-exists',
        title: 'The console’s branch already exists in the repository',
        status: 409,
        detail: 'The console never writes to a branch it did not just create: delete the branch on GitHub, then try again',
        extensions,
      });
    }
    case 'tampered':
      return problem(c, {
        type: 'actions-setup-pr-tampered',
        title: 'The branch changed while the pull request was being opened',
        status: 409,
        detail: 'The console closed the pull request it could not vouch for; delete the branch on GitHub, then try again',
      });
  }
}
