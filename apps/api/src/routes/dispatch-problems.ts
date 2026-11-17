import { problem, type ProblemExtensionValue, type WorkerContext } from '@worker/core';
import type { ApiEnv } from '../env';

type Context = WorkerContext<ApiEnv>;

/** The 422 of GitHub Actions dispatch (#670), shared by the switch and the enqueue routes. */

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
