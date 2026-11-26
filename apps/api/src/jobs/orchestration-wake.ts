import { ORCHESTRATE_MAX_STEPS, isStepNext, type StepNext } from '@shared/contracts';
import { newUlid, type Logger } from '@worker/core';
import { OrchestrationRepo, ProjectsRepo, TeamStateRepo, type NewAuditEvent, type NewJob } from '@worker/db';
import { currentResolvedViewOf, roleEnqueueLimitsOf } from '../team-config/resolved';

/**
 * The wake of a console run (#1039, ADR 0010 decision 1): server code with no model input. It reads `jobs` and
 * `team_state` only; the one value a step contributes is `metrics.next`, an enum, and an unknown value reads as
 * `children`.
 */

export type WakeDecision = 'enqueue-step' | 'wait-children' | 'wait-owner' | 'end-run' | 'cap' | 'paused';

export interface WakeInput {
  /** `null` while the project is idle: there is no run to wake, which reads as `end-run` and writes nothing. */
  readonly runId: string | null;
  readonly steps: number;
  readonly liveStep: boolean;
  /** Live jobs of the run besides its step: `task` children and the reviews a step requested. */
  readonly liveChildren: number;
  /** The newest step's `result` (`{summary, metrics, acted}` from its finish); `null` before any step ended. */
  readonly lastStepResult: Readonly<Record<string, unknown>> | null;
  readonly paused: boolean;
}

/** What the last step asked for; a step that ended without a valid `metrics.next` (failed, lost, cancelled) goes on. */
export function stepNextOf(result: Readonly<Record<string, unknown>> | null): StepNext {
  const metrics = result?.['metrics'];
  const next =
    typeof metrics === 'object' && metrics !== null
      ? (metrics as Record<string, unknown>)['next']
      : undefined;
  return isStepNext(next) ? next : 'children';
}

/**
 * Anything live waits: its own finish wakes the run again. Then the pause holds the run (resume wakes it in slice 2),
 * `done` ends it, the step cap ends it (threat model C8), `owner` waits for the owner, and anything else is a step.
 */
export function wakeDecisionOf(input: WakeInput): WakeDecision {
  if (input.runId === null) {
    return 'end-run';
  }
  if (input.liveStep || input.liveChildren > 0) {
    return 'wait-children';
  }
  if (input.paused) {
    return 'paused';
  }
  const next = stepNextOf(input.lastStepResult);
  if (next === 'done') {
    return 'end-run';
  }
  if (input.steps >= ORCHESTRATE_MAX_STEPS) {
    return 'cap';
  }
  return next === 'owner' ? 'wait-owner' : 'enqueue-step';
}

/** What woke the run, for its audit row. Start enqueues its first step in the lock's own batch; slice 2 adds the owner's answer and resume. */
export type WakeCause = 'finish';

export interface WakeResult {
  readonly decision: WakeDecision;
  /** The step this wake enqueued; `null` when it enqueued none (another wake won the dedupe key, or no step was due). */
  readonly stepId: string | null;
}

/** The step's dedupe key: one live orchestrator job per project (ADR 0010 decision 3), Run now's slots included. */
export const orchestratorDedupeKeyOf = (slug: string): string => `${slug}:orchestrator`;

/** Who enqueues a step, as `jobs.requested_by` and the audit actor record it. */
export const ORCHESTRATION_REQUESTER = 'system:orchestration';

function systemAudit(
  accountId: string,
  at: string,
  kind: NewAuditEvent['kind'],
  target: string,
  details: Readonly<Record<string, unknown>>,
): NewAuditEvent {
  return {
    accountId,
    at,
    actorKind: 'system',
    actor: 'orchestration',
    kind,
    target,
    details,
    ipCountry: null,
  };
}

/**
 * Applies `wakeDecisionOf` to the project's run as D1 holds it now. Two wakes racing (two children finishing at once)
 * meet at the dedupe index: one enqueues the step, the other's batch fails whole and is answered here as no step.
 */
export async function wakeOrchestration(
  db: D1Database,
  slug: string,
  cause: WakeCause,
  now: Date,
): Promise<WakeResult> {
  const teamState = new TeamStateRepo(db);
  const run = await teamState.orchestrationOf(slug);
  if (run.runId === null) {
    return { decision: 'end-run', stepId: null };
  }
  const runId = run.runId;
  const repo = new OrchestrationRepo(db);
  const [live, lastStep, state] = await Promise.all([
    repo.liveOfRun(slug, runId),
    repo.lastStepOf(slug, runId),
    teamState.get(slug),
  ]);
  const decision = wakeDecisionOf({
    runId,
    steps: run.steps,
    liveStep: live.some((job) => job.kind === 'orchestrate'),
    liveChildren: live.filter((job) => job.kind !== 'orchestrate').length,
    lastStepResult: lastStep?.result ?? null,
    paused: state.pausedAt !== null,
  });
  if (decision !== 'enqueue-step' && decision !== 'end-run' && decision !== 'cap') {
    return { decision, stepId: null };
  }
  const project = await new ProjectsRepo(db).findActiveBySlug(slug);
  if (project === null) {
    // An archived project's run takes no step; Stop still clears it.
    return { decision, stepId: null };
  }
  const at = now.toISOString();
  if (decision !== 'enqueue-step') {
    await repo.end(
      slug,
      runId,
      at,
      systemAudit(project.account_id, at, 'orchestration.stopped', slug, {
        run: runId,
        reason: decision === 'cap' ? 'cap' : 'done',
        steps: run.steps,
      }),
    );
    return { decision, stepId: null };
  }
  const stepNumber = run.steps + 1;
  const step: NewJob = {
    id: newUlid(now.getTime()),
    accountId: project.account_id,
    projectSlug: slug,
    kind: 'orchestrate',
    role: 'orchestrator',
    payload: { items: [], run: runId, step: stepNumber },
    priority: 1,
    requestedBy: ORCHESTRATION_REQUESTER,
    dedupeKey: orchestratorDedupeKeyOf(slug),
    needsLocal: lastStep?.needsLocal ?? false,
    maxMinutes: roleEnqueueLimitsOf(await currentResolvedViewOf(db, slug), 'orchestrator', null).maxMinutes,
    at,
  };
  const outcome = await repo.wake(
    slug,
    runId,
    step,
    systemAudit(project.account_id, at, 'job.dispatched', step.id, {
      kind: 'orchestrate',
      role: 'orchestrator',
      run: runId,
      step: stepNumber,
      cause,
      slug,
    }),
  );
  return { decision, stepId: outcome === 'enqueued' ? step.id : null };
}

/**
 * The wake after a job's finish. The finish has committed by then, so a failure here must not turn it into an error
 * the runner would retry: it is logged with the run's project, and the run waits for the next finish or Stop.
 */
export async function wakeAfterFinish(
  db: D1Database,
  logger: Logger,
  slug: string,
  now: Date,
): Promise<WakeResult | null> {
  try {
    const result = await wakeOrchestration(db, slug, 'finish', now);
    if (result.stepId !== null) {
      logger.info('orchestration step enqueued', { slug, jobId: result.stepId });
    }
    return result;
  } catch (error: unknown) {
    logger.error('orchestration wake failed', {
      slug,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
