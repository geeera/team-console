import { problem, type ProblemExtensionValue, type WorkerContext } from '@worker/core';
import type { ApiEnv } from '../env';

type Context = WorkerContext<ApiEnv>;

/** The 422s of GitHub Actions dispatch (#670), shared by the switch, the enqueue routes and the placement writes. */

/** 422 `access-source-hosted` (#706): a `subscription` project never runs on GitHub Actions. */
export function actionsOnSubscription(c: Context): Response {
  const extensions: Record<string, ProblemExtensionValue> = { field: 'dispatch' };
  return problem(c, {
    type: 'access-source-hosted',
    title: 'Invalid request',
    status: 422,
    detail: 'A project on a subscription never runs on GitHub Actions: switch its access source to an API key first',
    extensions,
  });
}

/** 422 `dispatch-placement-conflict` (#695 item 2): `pinned`/`failover` name machines a GitHub VM never is. */
export function placementConflict(c: Context, field: 'dispatch' | 'policy'): Response {
  const extensions: Record<string, ProblemExtensionValue> = { field };
  return problem(c, {
    type: 'dispatch-placement-conflict',
    title: 'Invalid request',
    status: 422,
    detail: 'A project on GitHub Actions has no pinned or failover placement: set placement to any runner first',
    extensions,
  });
}
