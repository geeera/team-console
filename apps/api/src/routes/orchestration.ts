import { Hono } from 'hono';
import {
  checkCreateChildJobInput,
  checkOrchestrationCommandInput,
  isJobKindBeforeCutover,
  isJobState,
  isUlid,
  type ChildJobListDto,
  type JobState,
  type OrchestrationDto,
} from '@shared/contracts';
import {
  newUlid,
  problem,
  type ProblemExtensionValue,
  type WorkerContext,
  type WorkerHonoEnv,
} from '@worker/core';
import {
  JobsRepo,
  OrchestrationRepo,
  TeamStateRepo,
  type JobRecord,
  type NewAuditEvent,
  type NewJob,
} from '@worker/db';
import { dispatchActionsJob, dispatchActionsJobs } from '../actions/dispatch';
import { withJobTokenHold } from '../auth/job-auth';
import {
  policyActorOfContext,
  trackerAccess,
  trackerProjectOfContext,
} from '../auth/tracker-access.middleware';
import type { ApiEnv } from '../env';
import type { ApiGitHub } from '../github';
import { ORCHESTRATION_REQUESTER, orchestratorDedupeKeyOf, stepNextOf } from '../jobs/orchestration-wake';
import { liveOrchestratorParentOf } from '../jobs/parent-job';
import { jsonBody } from '../json-body';
import { trackerProjectOf } from '../projects/lookup';
import { currentResolvedViewOf, roleEnqueueLimitsOf } from '../team-config/resolved';
import { trackerWriteRefusal } from '../tracker/context';
import { PAGE_MAX, SMALL_WRITE_MAX_BYTES, writeLimit } from '../tracker/http';
import { actionsOnSubscription } from './dispatch-problems';
import { jobAuditOf, jobDtoOf } from './jobs';
import { runPaused } from './team-commands';

type Context = WorkerContext<ApiEnv>;

const P = '/api/v1/projects/:slug';
const LIVE_STATES: ReadonlySet<JobState> = new Set(['queued', 'claimed', 'running']);

const IDLE: OrchestrationDto = {
  runId: null,
  steps: 0,
  state: 'idle',
  liveStepId: null,
  children: { queued: 0, running: 0, finished: 0, failed: 0 },
};

function invalid(c: Context, type: string, field: string, detail: string): Response {
  const extensions: Record<string, ProblemExtensionValue> = { field };
  return problem(c, { type, title: 'Invalid request', status: 422, detail, extensions });
}

const jobNotFound = (c: Context): Response =>
  problem(c, { type: 'job-not-found', title: 'Job not found', status: 404 });

const jobExists = (c: Context, detail: string): Response =>
  problem(c, { type: 'job-exists', title: 'Conflict', status: 409, detail });

/** The run as D1 holds it now: idle, waiting for the owner (nothing live, the last step said `owner`), or running. */
async function orchestrationDtoOf(db: D1Database, slug: string): Promise<OrchestrationDto> {
  const run = await new TeamStateRepo(db).orchestrationOf(slug);
  if (run.runId === null) {
    return IDLE;
  }
  const repo = new OrchestrationRepo(db);
  const [live, lastStep, children] = await Promise.all([
    repo.liveOfRun(slug, run.runId),
    repo.lastStepOf(slug, run.runId),
    repo.childCountsOf(slug, run.runId),
  ]);
  const isWaitingOwner = live.length === 0 && stepNextOf(lastStep?.result ?? null) === 'owner';
  return {
    runId: run.runId,
    steps: run.steps,
    state: isWaitingOwner ? 'waiting-owner' : 'running',
    liveStepId: live.find((job) => job.kind === 'orchestrate')?.id ?? null,
    children,
  };
}

/**
 * The member-less body of Start and Stop: none at all, or JSON that `checkOrchestrationCommandInput` judges. Text that
 * is not JSON reads as `null`, which it refuses.
 */
async function commandRefusal(c: Context): Promise<Response | null> {
  const text = await c.req.text();
  let body: unknown;
  if (text.trim() !== '') {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      // Malformed JSON is the client's input, answered as a validation problem; the parser's message is dropped.
      body = null;
    }
  }
  const input = checkOrchestrationCommandInput(body);
  return input.ok ? null : invalid(c, 'orchestration-invalid', input.field, input.detail);
}

/**
 * #775: a job is not a tracker write, so a project still on GitHub Issues takes the kinds of
 * `JOB_KINDS_BEFORE_CUTOVER` (team-console runs its console runs there until #437); any other kind waits for the cut-over.
 */
function cutOverRefusal(c: Context, kind: 'orchestrate' | 'task'): Response | null {
  const refusal = trackerWriteRefusal(c, trackerProjectOf(trackerProjectOfContext(c)));
  return refusal !== null && !isJobKindBeforeCutover(kind) ? refusal : null;
}

/**
 * Console-driven orchestration (#1039, #633 slice 1a, ADR 0010), behind the route matrix:
 * - `POST …/orchestration/start|stop` (owner): the run lock and its first step in one batch; Stop is a hard cancel of
 *   every live job of the run in the batch that clears it (owner decision 2026-11-26).
 * - `GET …/orchestration` (read): the run as an `OrchestrationDto`.
 * - `POST …/jobs/:id/children` (the orchestrator job, of itself): `task` jobs for `TASK_ROLES`, one per item.
 * - `GET …/jobs/:id/children` (read).
 * - `POST …/jobs/:id/cancel` (owner): the job and its queued children; the token dies in the same statement.
 * Every write has an `audit_events` row with ids and enums only.
 */
export function createOrchestrationRoutes(github: ApiGitHub): Hono<WorkerHonoEnv<ApiEnv>> {
  return new Hono<WorkerHonoEnv<ApiEnv>>()
    .post(
      '/:slug/orchestration/start',
      trackerAccess(`POST ${P}/orchestration/start`),
      writeLimit(SMALL_WRITE_MAX_BYTES),
      async (c) => startRun(c, github),
    )
    .post(
      '/:slug/orchestration/stop',
      trackerAccess(`POST ${P}/orchestration/stop`),
      writeLimit(SMALL_WRITE_MAX_BYTES),
      async (c) => stopRun(c),
    )
    .get('/:slug/orchestration', trackerAccess(`GET ${P}/orchestration`), async (c) => {
      c.header('Cache-Control', 'no-store');
      return c.json(await orchestrationDtoOf(c.env.DB, trackerProjectOfContext(c).slug));
    })
    .post(
      '/:slug/jobs/:id/children',
      trackerAccess(`POST ${P}/jobs/:id/children`),
      writeLimit(SMALL_WRITE_MAX_BYTES),
      async (c) => createChildren(c, github),
    )
    .get('/:slug/jobs/:id/children', trackerAccess(`GET ${P}/jobs/:id/children`), async (c) =>
      listChildren(c),
    )
    .post(
      '/:slug/jobs/:id/cancel',
      trackerAccess(`POST ${P}/jobs/:id/cancel`),
      writeLimit(SMALL_WRITE_MAX_BYTES),
      async (c) => cancelJob(c),
    );
}

async function startRun(c: Context, github: ApiGitHub): Promise<Response> {
  const row = trackerProjectOfContext(c);
  const refused = await commandRefusal(c);
  if (refused !== null) {
    return refused;
  }
  const notCutOver = cutOverRefusal(c, 'orchestrate');
  if (notCutOver !== null) {
    return notCutOver;
  }
  // The claim holds every job of a paused team anyway; refusing here tells the owner at once, as Run now's panel does.
  if ((await new TeamStateRepo(c.env.DB).get(row.slug)).pausedAt !== null) {
    return runPaused(c);
  }
  const now = new Date();
  const at = now.toISOString();
  const runId = newUlid(now.getTime());
  const stepId = newUlid(now.getTime());
  const step: NewJob = {
    id: stepId,
    accountId: row.account_id,
    projectSlug: row.slug,
    kind: 'orchestrate',
    role: 'orchestrator',
    payload: { items: [], run: runId, step: 1 },
    priority: 1,
    requestedBy: ORCHESTRATION_REQUESTER,
    dedupeKey: orchestratorDedupeKeyOf(row.slug),
    needsLocal: false,
    // The orchestrator is never off (NEVER_OFF_ROLES); its `max_minutes` bounds every step.
    maxMinutes: roleEnqueueLimitsOf(await currentResolvedViewOf(c.env.DB, row.slug), 'orchestrator', null)
      .maxMinutes,
    at,
  };
  const outcome = await new OrchestrationRepo(c.env.DB).start(
    row.slug,
    runId,
    step,
    jobAuditOf(c, row.account_id, at, 'orchestration.started', row.slug, { run: runId, step: stepId }),
    jobAuditOf(c, row.account_id, at, 'job.dispatched', stepId, {
      kind: 'orchestrate',
      role: 'orchestrator',
      run: runId,
      step: 1,
      slug: row.slug,
    }),
  );
  switch (outcome) {
    case 'orchestration-active':
      return problem(c, {
        type: 'orchestration-active',
        title: 'Conflict',
        status: 409,
        detail: 'A team run is already on for this project; stop it first',
      });
    case 'job-exists':
      return jobExists(c, 'An orchestrator job is already queued or running for the project');
    case 'access-source-hosted':
      return actionsOnSubscription(c);
    case 'started':
      break;
  }
  c.get('logger').info('orchestration started', { slug: row.slug, runId, jobId: stepId });
  const queued = await new JobsRepo(c.env.DB).findInProject(row.slug, stepId);
  // #670: an Actions project's step is dispatched now, as Run now's is; a failed call leaves it `failed`.
  if (queued?.dispatch === 'actions') {
    await dispatchActionsJob({ env: c.env, github, logger: c.get('logger') }, queued.id);
  }
  return c.json(await orchestrationDtoOf(c.env.DB, row.slug), 201);
}

async function stopRun(c: Context): Promise<Response> {
  const row = trackerProjectOfContext(c);
  const refused = await commandRefusal(c);
  if (refused !== null) {
    return refused;
  }
  const idle = (): Response =>
    problem(c, {
      type: 'orchestration-idle',
      title: 'Conflict',
      status: 409,
      detail: 'No team run is on for this project',
    });
  const run = await new TeamStateRepo(c.env.DB).orchestrationOf(row.slug);
  if (run.runId === null) {
    return idle();
  }
  const at = new Date().toISOString();
  const stopped = await new OrchestrationRepo(c.env.DB).stop(
    row.slug,
    run.runId,
    at,
    jobAuditOf(c, row.account_id, at, 'orchestration.stopped', row.slug, {
      run: run.runId,
      reason: 'owner',
      steps: run.steps,
    }),
  );
  if (!stopped.stopped) {
    // The run ended (or another Stop won) between the read and the batch.
    return idle();
  }
  c.get('logger').info('orchestration stopped', {
    slug: row.slug,
    runId: run.runId,
    cancelled: stopped.cancelled,
  });
  return c.json(await orchestrationDtoOf(c.env.DB, row.slug));
}

async function createChildren(c: Context, github: ApiGitHub): Promise<Response> {
  const actor = policyActorOfContext(c);
  if (actor.kind !== 'job') {
    // The matrix row admits the orchestrator job only; anything else reaching here is a bug, never an open door.
    throw new Error('a child job request reached the handler without a job actor');
  }
  const row = trackerProjectOfContext(c);
  if (c.req.param('id') !== actor.jobId) {
    return problem(c, {
      type: 'child-not-own-job',
      title: 'Not Found',
      status: 404,
      detail: 'A job mints children of itself only',
    });
  }
  const notCutOver = cutOverRefusal(c, 'task');
  if (notCutOver !== null) {
    return notCutOver;
  }
  const input = checkCreateChildJobInput(await jsonBody(c));
  if (!input.ok) {
    return invalid(c, 'child-job-invalid', input.field, input.detail);
  }
  const { role, items, base, branchPrefix, pr } = input.value;
  const parent = await liveOrchestratorParentOf(c.env.DB, actor, row.slug);
  if (parent === null) {
    c.get('logger').warn('child jobs refused', { type: 'child-parent-not-live' });
    return problem(c, {
      type: 'child-parent-not-live',
      title: 'Forbidden',
      status: 403,
      detail: 'Children are minted by a claimed or running orchestrator job of the project',
    });
  }
  // #684: a child takes its role's limits as configured now; the claim stamps the role's model from the same view.
  const limits = roleEnqueueLimitsOf(await currentResolvedViewOf(c.env.DB, row.slug), role, null);
  if (!limits.enabled) {
    return problem(c, {
      type: 'role-disabled',
      title: 'Conflict',
      status: 409,
      detail: 'The team configuration has this role switched off',
      extensions: { role },
    });
  }
  const runValue = parent.payload['run'];
  const run = isUlid(runValue) ? runValue : null;
  const now = new Date();
  const at = now.toISOString();
  const entries = items.map((item, index): { readonly job: NewJob; readonly audit: NewAuditEvent } => {
    // One millisecond apart, so the children list (by id) in the order the step asked for them.
    const id = newUlid(now.getTime() + index);
    return {
      job: {
        id,
        // The parent row's, never the request's: a child stays in its parent's account and project.
        accountId: parent.accountId,
        projectSlug: parent.projectSlug,
        kind: 'task',
        role,
        payload: { items: [item], role, base, branchPrefix, pr, run },
        priority: 2,
        requestedBy: `job:${parent.id}`,
        // One live child per item (the 0022 overlap guard), across steps and runs.
        dedupeKey: `${row.slug}:task:${String(item)}`,
        needsLocal: parent.needsLocal,
        maxMinutes: limits.maxMinutes,
        at,
        parentJobId: parent.id,
      },
      audit: jobAuditOf(c, parent.accountId, at, 'job.dispatched', id, {
        kind: 'task',
        role,
        items: [item],
        parent: parent.id,
        run,
        slug: row.slug,
      }),
    };
  });
  const jobs = new JobsRepo(c.env.DB);
  // The parent is judged again inside the batch (#580): a cancel or Stop since authentication wins.
  const enqueued = await withJobTokenHold(c, now, (hold) => jobs.enqueueAll(entries, hold));
  if (enqueued instanceof Response) {
    return enqueued;
  }
  if (enqueued === 'job-exists') {
    return jobExists(c, 'An item of the request already has a live task job');
  }
  if (enqueued === 'access-source-hosted') {
    return actionsOnSubscription(c);
  }
  const created: JobRecord[] = [];
  for (const { job } of entries) {
    const stored = await jobs.findById(job.id);
    if (stored !== null) {
      created.push(stored);
    }
  }
  // #670: the children are dispatched now when the project runs on GitHub Actions.
  await dispatchActionsJobs({ env: c.env, github, logger: c.get('logger') }, created);
  const answered: JobRecord[] = [];
  for (const job of created) {
    answered.push((await jobs.findById(job.id)) ?? job);
  }
  c.get('logger').info('child jobs created', { slug: row.slug, jobId: parent.id, created: answered.length });
  const body: ChildJobListDto = { jobs: answered.map(jobDtoOf), nextCursor: null };
  c.header('Cache-Control', 'no-store');
  return c.json(body, 201);
}

async function listChildren(c: Context): Promise<Response> {
  const row = trackerProjectOfContext(c);
  const id = c.req.param('id') ?? '';
  const parent = isUlid(id) ? await new JobsRepo(c.env.DB).findInProject(row.slug, id) : null;
  if (parent === null) {
    return jobNotFound(c);
  }
  const state = c.req.query('state');
  const after = c.req.query('after');
  if ((state !== undefined && !isJobState(state)) || (after !== undefined && !isUlid(after))) {
    return problem(c, { type: 'query-invalid', title: 'Invalid request', status: 400 });
  }
  const rows = await new OrchestrationRepo(c.env.DB).childrenOf(row.slug, parent.id, {
    ...(state === undefined ? {} : { state }),
    after: after ?? null,
    limit: PAGE_MAX,
  });
  const page = rows.slice(0, PAGE_MAX);
  const body: ChildJobListDto = {
    jobs: page.map(jobDtoOf),
    nextCursor: rows.length > PAGE_MAX ? (page.at(-1)?.id ?? null) : null,
  };
  c.header('Cache-Control', 'no-store');
  return c.json(body);
}

async function cancelJob(c: Context): Promise<Response> {
  const row = trackerProjectOfContext(c);
  const id = c.req.param('id') ?? '';
  const jobs = new JobsRepo(c.env.DB);
  const job = isUlid(id) ? await jobs.findInProject(row.slug, id) : null;
  if (job === null) {
    return jobNotFound(c);
  }
  const notCancellable = (): Response =>
    problem(c, {
      type: 'job-not-cancellable',
      title: 'Conflict',
      status: 409,
      detail: `The job is ${job.state}`,
    });
  if (!LIVE_STATES.has(job.state)) {
    return notCancellable();
  }
  const at = new Date().toISOString();
  const outcome = await new OrchestrationRepo(c.env.DB).cancel(
    row.slug,
    job.id,
    at,
    jobAuditOf(c, row.account_id, at, 'job.cancelled', job.id, {
      kind: job.kind,
      role: job.role,
      state: job.state,
      slug: row.slug,
    }),
  );
  if (!outcome.cancelled) {
    // It ended (finished, lost, or another cancel) between the read and the batch.
    return problem(c, {
      type: 'job-not-cancellable',
      title: 'Conflict',
      status: 409,
      detail: 'The job ended',
    });
  }
  c.get('logger').info('job cancelled', { slug: row.slug, jobId: job.id, children: outcome.children });
  const cancelled = await jobs.findInProject(row.slug, job.id);
  return c.json(cancelled === null ? null : jobDtoOf(cancelled));
}
