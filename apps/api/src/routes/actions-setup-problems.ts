import { ACTIONS_NOT_READY, type ActionsSetupItemId } from '@shared/contracts';
import { problem, type ProblemExtensionValue, type WorkerContext } from '@worker/core';
import { RateLimitsRepo, rateWindowOf, retryAfterOf } from '@worker/db';
import type { ReadinessOutcome } from '../actions/readiness';
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
