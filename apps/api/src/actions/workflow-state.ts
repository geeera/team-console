import type { Logger } from '@worker/core';
import { ActionsWorkflowStateRepo, type ActionsWorkflowState } from '@worker/db';

/**
 * Records a workflow judgement for "Needs you" (#874). A failed write costs one stale Needs-you row, never the
 * caller's own answer (the readiness check, a dispatch failure): it is logged and the caller goes on.
 */
export async function recordWorkflowJudgement(
  deps: { readonly env: { readonly DB: D1Database }; readonly logger: Logger },
  slug: string,
  state: ActionsWorkflowState,
): Promise<void> {
  try {
    await new ActionsWorkflowStateRepo(deps.env.DB).record(slug, state);
  } catch (error: unknown) {
    deps.logger.error('actions workflow judgement not recorded', {
      slug,
      status: state.status,
      error: error instanceof Error ? error.name : 'unknown',
    });
  }
}
