import { isUlid } from './account';
import { isNullable } from './guards';
import { JOB_ITEMS_MAX, isJobDto, type JobDto } from './job';
import { InputError, checked, isRecord, oneOf, record, type InputCheck } from './tracker/inputs';

/**
 * Console-driven orchestration (#633 slice 1a, ADR 0010): a run is a chain of short `orchestrate` step jobs; a step
 * enqueues `task` children through `POST …/jobs/:id/children` and finishes, and the console wakes the next step when
 * nothing of the run is live. The run is `team_state.orchestrate_run_id`; every step and child carries `payload.run`.
 */

/**
 * The roles a step may mint a `task` child for (ADR 0010 decision 4, slice 1). Never a verdict role (`qa`,
 * `reviewer`, `security`, R2): reviews stay top-level `review` jobs requested through `…/prs/:number/reviews`.
 */
export const TASK_ROLES = ['dev', 'dev-light', 'dev-heavy'] as const;
export type TaskRole = (typeof TASK_ROLES)[number];
export const isTaskRole = (value: unknown): value is TaskRole =>
  (TASK_ROLES as readonly unknown[]).includes(value);

/**
 * The most steps one run takes before it ends (threat model C8: a step loop). Owner decision 2026-11-26: 20, not the
 * 40 of the architect note, since every step is an orchestrator-model turn on the owner's subscription.
 */
export const ORCHESTRATE_MAX_STEPS = 20;

export const CHILD_BASES = ['dev', 'stage', 'main'] as const;
export type ChildBase = (typeof CHILD_BASES)[number];
const isChildBase = (value: unknown): value is ChildBase =>
  (CHILD_BASES as readonly unknown[]).includes(value);

export const CHILD_BRANCH_PREFIXES = ['feature', 'fix', 'hotfix', 'chore'] as const;
export type ChildBranchPrefix = (typeof CHILD_BRANCH_PREFIXES)[number];
const isChildBranchPrefix = (value: unknown): value is ChildBranchPrefix =>
  (CHILD_BRANCH_PREFIXES as readonly unknown[]).includes(value);

/**
 * `POST /api/v1/projects/:slug/jobs/:id/children`: enums and numbers only, so nothing a model wrote reaches a child's
 * prompt as text (threat model C8, ADR 0010 decision 6). One child per item; `pr` names a pull request to rework.
 */
export interface CreateChildJobInput {
  readonly role: TaskRole;
  readonly items: readonly number[];
  readonly base: ChildBase;
  readonly branchPrefix: ChildBranchPrefix;
  readonly pr: number | null;
}

const isItemNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

export function checkCreateChildJobInput(body: unknown): InputCheck<CreateChildJobInput> {
  return checked(() => {
    const fields = record(body, ['role', 'items', 'base', 'branchPrefix', 'pr']);
    const role = fields['role'];
    if (!isTaskRole(role)) {
      throw new InputError('role', `role must be one of ${TASK_ROLES.join(', ')}`);
    }
    const items = fields['items'];
    if (
      !Array.isArray(items) ||
      items.length === 0 ||
      items.length > JOB_ITEMS_MAX ||
      !items.every(isItemNumber)
    ) {
      throw new InputError('items', `items must be 1 to ${String(JOB_ITEMS_MAX)} item numbers`);
    }
    const pr = fields['pr'] ?? null;
    if (pr !== null && !isItemNumber(pr)) {
      throw new InputError('pr', 'pr must be a pull request number');
    }
    return {
      role,
      items: [...new Set<number>(items as number[])],
      base: oneOf('base', fields['base'] ?? 'dev', isChildBase),
      branchPrefix: oneOf('branchPrefix', fields['branchPrefix'] ?? 'feature', isChildBranchPrefix),
      pr,
    };
  });
}

/** `POST|GET …/jobs/:id/children`: the children, oldest first; `nextCursor` is the last id shown when there are more. */
export interface ChildJobListDto {
  readonly jobs: readonly JobDto[];
  readonly nextCursor: string | null;
}

export function isChildJobListDto(value: unknown): value is ChildJobListDto {
  return (
    isRecord(value) &&
    Array.isArray(value['jobs']) &&
    value['jobs'].every(isJobDto) &&
    isNullable(value['nextCursor'], isUlid)
  );
}

/**
 * Where a run stands: `idle` no run; `running` a step or a child is live, or the next step is due; `waiting-owner`
 * nothing is live and the last step finished with `next: owner`; `stopping` is reserved for the graceful stop of
 * slice 2 (Stop is a hard cancel in 1a, so this slice never answers it).
 */
export const ORCHESTRATION_STATES = ['idle', 'running', 'waiting-owner', 'stopping'] as const;
export type OrchestrationState = (typeof ORCHESTRATION_STATES)[number];
const isOrchestrationState = (value: unknown): value is OrchestrationState =>
  (ORCHESTRATION_STATES as readonly unknown[]).includes(value);

/** The run's `task` children by state: `running` counts claimed ones too, `failed` lost and cancelled ones. */
export interface OrchestrationChildCounts {
  readonly queued: number;
  readonly running: number;
  readonly finished: number;
  readonly failed: number;
}

/** `GET /api/v1/projects/:slug/orchestration`. */
export interface OrchestrationDto {
  readonly runId: string | null;
  readonly steps: number;
  readonly state: OrchestrationState;
  readonly liveStepId: string | null;
  readonly children: OrchestrationChildCounts;
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function isChildCounts(value: unknown): value is OrchestrationChildCounts {
  return (
    isRecord(value) &&
    isCount(value['queued']) &&
    isCount(value['running']) &&
    isCount(value['finished']) &&
    isCount(value['failed'])
  );
}

export function isOrchestrationDto(value: unknown): value is OrchestrationDto {
  if (!isRecord(value)) {
    return false;
  }
  const steps = value['steps'];
  return (
    isNullable(value['runId'], isUlid) &&
    isCount(steps) &&
    steps <= ORCHESTRATE_MAX_STEPS &&
    isOrchestrationState(value['state']) &&
    (value['state'] === 'idle') === (value['runId'] === null) &&
    isNullable(value['liveStepId'], isUlid) &&
    isChildCounts(value['children'])
  );
}

/**
 * What a step tells the console it wants next, as `finish`'s `metrics.next` (ADR 0010 decision 2). An unknown or
 * missing value reads as `children`: the wake keeps going within `ORCHESTRATE_MAX_STEPS` rather than stall a run.
 */
export const STEP_NEXTS = ['children', 'review', 'owner', 'done'] as const;
export type StepNext = (typeof STEP_NEXTS)[number];
export const isStepNext = (value: unknown): value is StepNext =>
  (STEP_NEXTS as readonly unknown[]).includes(value);

/**
 * The problem `type` slugs of the orchestration routes: `orchestration-active` (a run is on), `orchestration-idle`
 * (no run to stop), `child-role` (only the orchestrator job mints children), `child-parent-not-live` (the parent is
 * not a claimed or running orchestrator job), `child-not-own-job` (a step mints children of itself only),
 * `job-not-cancellable` (the job already ended).
 */
export const ORCHESTRATION_PROBLEMS = [
  'orchestration-active',
  'orchestration-idle',
  'child-role',
  'child-parent-not-live',
  'child-not-own-job',
  'job-not-cancellable',
] as const;
export type OrchestrationProblemType = (typeof ORCHESTRATION_PROBLEMS)[number];
