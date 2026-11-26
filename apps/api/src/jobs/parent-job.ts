import { JobsRepo, type JobRecord } from '@worker/db';
import type { PolicyActor } from '../auth/policy';

export type JobActor = Extract<PolicyActor, { kind: 'job' }>;

const LIVE_PARENT_STATES: ReadonlySet<JobRecord['state']> = new Set(['claimed', 'running']);

/**
 * The lineage rule of #612 (ADR 0006 R2), shared by the review request and `…/jobs/:id/children` (#1039): a job a job
 * asks for has as its parent the job named by the requester's identity, never by a body, and that parent must be a
 * claimed or running orchestrator job of this project. `null` otherwise, so a stand-in naming no job, or a token
 * outliving its job, enqueues nothing; each route words its own refusal.
 */
export async function liveOrchestratorParentOf(
  db: D1Database,
  actor: JobActor,
  slug: string,
): Promise<JobRecord | null> {
  const parent = await new JobsRepo(db).findInProject(slug, actor.jobId);
  return parent !== null && parent.role === 'orchestrator' && LIVE_PARENT_STATES.has(parent.state)
    ? parent
    : null;
}
