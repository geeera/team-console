import { env } from 'cloudflare:test';
import {
  OWNER_ACCOUNT_ID,
  TEAM_CONFIG_SCHEMA,
  isChildJobListDto,
  isOrchestrationDto,
  type ChildJobListDto,
  type ClaimResponse,
  type JobDto,
  type OrchestrationDto,
  type TeamConfigDto,
} from '@shared/contracts';
import {
  cancelJobsInFlight,
  enqueueJob,
  enrolRunner,
  sendAsJob,
  sendAsRunner,
  type TestRunner,
} from '../testing/runner-kit';
import { seedMembership, seedSessionUser, sendAsSession } from '../testing/session-kit';
import {
  countRows,
  jobActor,
  seedGitHubProject,
  seedTrackerProject,
  send,
  slugOf,
} from '../testing/tracker-kit';

// #1039 (#633 slice 1a, ADR 0010): the console's orchestration routes on local D1, through the whole app — the run
// lock, Stop's one-batch cancel, a step's children, the owner's cancel and the wake on finish. Who reaches each row
// at all is proven cell by cell in tracker-matrix.spec.ts.

const P = '/api/v1/projects';

interface JobRow {
  readonly id: string;
  readonly kind: string;
  readonly role: string;
  readonly state: string;
  readonly payload: string;
  readonly requested_by: string;
  readonly dedupe_key: string | null;
  readonly parent_job_id: string | null;
  readonly needs_local: number;
  readonly max_minutes: number;
  readonly account_id: string;
  readonly token_hash: string | null;
  readonly lease_until: string | null;
  readonly result: string | null;
}

async function rowOf(id: string): Promise<JobRow> {
  const row = await env.DB.prepare(`SELECT * FROM jobs WHERE id = ?1`).bind(id).first<JobRow>();
  if (row === null) {
    throw new Error(`no job ${id}`);
  }
  return row;
}

async function rowsOf(slug: string, kind: string): Promise<JobRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM jobs WHERE project_slug = ?1 AND kind = ?2 ORDER BY id`,
  )
    .bind(slug, kind)
    .all<JobRow>();
  return results;
}

async function auditOf(kind: string, target: string): Promise<{ actor_kind: string; details: string }[]> {
  const { results } = await env.DB.prepare(
    `SELECT actor_kind, details FROM audit_events WHERE kind = ?1 AND target = ?2 ORDER BY id`,
  )
    .bind(kind, target)
    .all<{ actor_kind: string; details: string }>();
  return results;
}

async function configure(slug: string, members: Record<string, unknown>): Promise<void> {
  const current = (await (await send('GET', `${P}/${slug}/team-config`)).json()) as TeamConfigDto;
  const response = await send(
    'PUT',
    `${P}/${slug}/team-config`,
    { config: { schema: TEAM_CONFIG_SCHEMA, ...members } },
    { ifMatch: `"${String(current.revision)}"` },
  );
  expect(response.status).toBe(200);
}

/** A runner of the owner's account serving `slug` alone, holding up to four jobs at once. */
const runnerOf = (slug: string): Promise<TestRunner> =>
  enrolRunner(OWNER_ACCOUNT_ID, {
    allowedProjects: [slug],
    enrol: { capabilities: { local: true, maxConcurrency: 4 } },
  });

async function claim(runner: TestRunner): Promise<ClaimResponse> {
  const response = await sendAsRunner(runner, 'POST', '/api/v1/runner/jobs/claim', {});
  if (response.status !== 200) {
    throw new Error(`claiming answered ${String(response.status)}`);
  }
  return (await response.json()) as ClaimResponse;
}

async function finish(runner: TestRunner, jobId: string, next?: string): Promise<Response> {
  return sendAsRunner(runner, 'POST', `/api/v1/runner/jobs/${jobId}/finish`, {
    result: 'finished',
    summary: 'done',
    metrics: next === undefined ? {} : { next },
  });
}

const start = (slug: string): Promise<Response> => send('POST', `${P}/${slug}/orchestration/start`, {});
const stop = (slug: string): Promise<Response> => send('POST', `${P}/${slug}/orchestration/stop`, {});

async function orchestrationOf(slug: string): Promise<OrchestrationDto> {
  const response = await send('GET', `${P}/${slug}/orchestration`);
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  expect(isOrchestrationDto(body)).toBe(true);
  return body as OrchestrationDto;
}

/** A started run whose first step a runner claimed: the step's real token, as the runner hands it to the job. */
async function runningStep(slug: string) {
  expect((await start(slug)).status).toBe(201);
  const runner = await runnerOf(slug);
  const claimed = await claim(runner);
  expect(claimed.job.kind).toBe('orchestrate');
  const asStep = (method: string, path: string, body?: unknown) =>
    sendAsJob(runner, claimed.jobToken, method, path, body);
  const children = (body: unknown) => asStep('POST', `${P}/${slug}/jobs/${claimed.job.id}/children`, body);
  return { runner, stepId: claimed.job.id, stepToken: claimed.jobToken, asStep, children };
}

beforeEach(async () => {
  // D1 is shared by the file's cases and the account's entitled concurrency counts them all (#746).
  await cancelJobsInFlight();
});

describe('POST …/orchestration/start', () => {
  it('takes the run lock and queues step 1 under the shared orchestrator key, audited', async () => {
    const { slug } = await seedTrackerProject();
    await configure(slug, { roles: { orchestrator: { max_minutes: 45 } } });
    const response = await start(slug);
    expect(response.status).toBe(201);
    const body = (await response.json()) as OrchestrationDto;
    expect(body).toMatchObject({ state: 'running', steps: 1, children: { queued: 0, running: 0 } });
    const [step] = await rowsOf(slug, 'orchestrate');
    expect(step).toMatchObject({
      id: body.liveStepId,
      role: 'orchestrator',
      state: 'queued',
      dedupe_key: `${slug}:orchestrator`,
      requested_by: 'system:orchestration',
      max_minutes: 45,
      parent_job_id: null,
    });
    expect(JSON.parse(step?.payload ?? '{}')).toEqual({ items: [], run: body.runId, step: 1 });
    const [started] = await auditOf('orchestration.started', slug);
    expect(JSON.parse(started?.details ?? '{}')).toEqual({ run: body.runId, step: body.liveStepId });
    expect(await auditOf('job.dispatched', step?.id ?? '')).toHaveLength(1);
  });

  it('refuses a second start with 409 orchestration-active, writing nothing', async () => {
    const { slug } = await seedTrackerProject();
    expect((await start(slug)).status).toBe(201);
    const jobs = await countRows('jobs', slug);
    const second = await start(slug);
    expect(second.status).toBe(409);
    expect(await slugOf(second)).toBe('orchestration-active');
    expect(await countRows('jobs', slug)).toBe(jobs);
  });

  it('refuses a paused team with 409 run-paused, in the team commands’ shape', async () => {
    const { slug } = await seedTrackerProject();
    await env.DB.prepare(
      `INSERT INTO team_state (project_slug, paused_at, paused_by, failed_streak, updated_at) VALUES (?1, ?2, 'owner', 0, ?2)`,
    )
      .bind(slug, new Date().toISOString())
      .run();
    const response = await start(slug);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      type: expect.stringContaining('run-paused') as unknown,
      title: 'Development is paused',
      detail: 'Resume development first',
    });
    expect((await orchestrationOf(slug)).state).toBe('idle');
  });

  it('refuses while Run now’s slot holds the orchestrator key (409 job-exists), the lock left free', async () => {
    const { slug } = await seedTrackerProject();
    await enqueueJob(slug, { kind: 'slot-dev' });
    const response = await start(slug);
    expect(response.status).toBe(409);
    expect(await slugOf(response)).toBe('job-exists');
    expect((await orchestrationOf(slug)).state).toBe('idle');
    expect(await rowsOf(slug, 'orchestrate')).toHaveLength(0);
  });

  it.each([
    ['a member', { steps: 40 }],
    ['text that is not JSON', '{steps'],
  ])('refuses a body with %s with 422 orchestration-invalid, writing nothing', async (_, body) => {
    const { slug } = await seedTrackerProject();
    const response = await send('POST', `${P}/${slug}/orchestration/start`, body);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      type: expect.stringContaining('orchestration-invalid') as unknown,
      field: 'body',
    });
    expect(await countRows('jobs', slug)).toBe(0);
    expect((await orchestrationOf(slug)).state).toBe('idle');
  });

  it('starts on a project still on GitHub Issues (team-console until #437)', async () => {
    const slug = await seedGitHubProject();
    expect((await start(slug)).status).toBe(201);
  });

  it('is the owner’s: a member and a job get 403 owner-only', async () => {
    const { slug } = await seedTrackerProject();
    const member = await seedSessionUser('member');
    await seedMembership(OWNER_ACCOUNT_ID, member.userId, 'member');
    const asMember = await sendAsSession(member, 'POST', `${P}/${slug}/orchestration/start`, {});
    expect(asMember.status).toBe(403);
    expect(await slugOf(asMember)).toBe('owner-only');
    const asJob = await send(
      'POST',
      `${P}/${slug}/orchestration/start`,
      {},
      { job: jobActor('orchestrator') },
    );
    expect(asJob.status).toBe(403);
    expect(await slugOf(asJob)).toBe('owner-only');
    expect(await countRows('jobs', slug)).toBe(0);
  });
});

describe('POST …/orchestration/stop', () => {
  it('cancels the step and its queued, claimed and running children in one batch and clears the run', async () => {
    const { slug } = await seedTrackerProject();
    const { stepId, children, asStep } = await runningStep(slug);
    const created = await children({ role: 'dev', items: [1, 2, 3, 4] });
    expect(created.status).toBe(201);
    const ids = ((await created.json()) as ChildJobListDto).jobs.map((job) => job.id);
    const worker = await runnerOf(slug);
    const [claimedChild, runningChild, finishedChild] = [
      await claim(worker),
      await claim(worker),
      await claim(worker),
    ];
    await env.DB.prepare(`UPDATE jobs SET state = 'running', started_at = ?2 WHERE id = ?1`)
      .bind(runningChild.job.id, new Date().toISOString())
      .run();
    expect((await finish(worker, finishedChild.job.id)).status).toBe(200);
    const runId = (await orchestrationOf(slug)).runId;

    const response = await stop(slug);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: 'idle', runId: null, steps: 0 });
    const queuedChild = ids.find(
      (id) => ![claimedChild.job.id, runningChild.job.id, finishedChild.job.id].includes(id),
    );
    for (const id of [stepId, queuedChild ?? '', claimedChild.job.id, runningChild.job.id]) {
      expect(await rowOf(id), id).toMatchObject({
        state: 'cancelled',
        token_hash: null,
        lease_until: null,
        result: '{"reason":"orchestration-stopped"}',
      });
    }
    expect((await rowOf(finishedChild.job.id)).state).toBe('finished');
    const [stopped] = await auditOf('orchestration.stopped', slug);
    expect(JSON.parse(stopped?.details ?? '{}')).toMatchObject({ run: runId, reason: 'owner' });
    // The step's token died in the batch: its next call is refused at the door.
    const after = await asStep('GET', `${P}/${slug}/jobs/${stepId}`);
    expect(after.status).toBe(401);
  });

  it('answers 409 orchestration-idle when no run is on', async () => {
    const { slug } = await seedTrackerProject();
    const response = await stop(slug);
    expect(response.status).toBe(409);
    expect(await slugOf(response)).toBe('orchestration-idle');
  });
});

describe('GET …/orchestration', () => {
  it('reads idle, then the running run with its child counts, for the owner and a job alike', async () => {
    const { slug } = await seedTrackerProject();
    expect(await orchestrationOf(slug)).toEqual({
      runId: null,
      steps: 0,
      state: 'idle',
      liveStepId: null,
      children: { queued: 0, running: 0, finished: 0, failed: 0 },
    });
    const { stepId, children, asStep } = await runningStep(slug);
    expect((await children({ role: 'dev-light', items: [7, 8] })).status).toBe(201);
    const read = await asStep('GET', `${P}/${slug}/orchestration`);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      state: 'running',
      steps: 1,
      liveStepId: stepId,
      children: { queued: 2, running: 0, finished: 0, failed: 0 },
    });
  });
});

describe('POST …/jobs/:id/children', () => {
  it('mints a task job per item for the step itself, from the parent row and the role’s configuration', async () => {
    const { slug } = await seedTrackerProject();
    await configure(slug, { roles: { dev: { max_minutes: 30 } } });
    const { stepId, children } = await runningStep(slug);
    const runId = (await orchestrationOf(slug)).runId;
    const response = await children({
      role: 'dev',
      items: [12, 13],
      base: 'stage',
      branchPrefix: 'fix',
      pr: 40,
    });
    expect(response.status).toBe(201);
    const body: unknown = await response.json();
    expect(isChildJobListDto(body)).toBe(true);
    const dtos = (body as ChildJobListDto).jobs;
    expect(dtos.map((job) => [job.kind, job.role, job.items, job.state, job.priority])).toEqual([
      ['task', 'dev', [12], 'queued', 2],
      ['task', 'dev', [13], 'queued', 2],
    ]);
    const parent = await rowOf(stepId);
    for (const [index, item] of [12, 13].entries()) {
      const row = await rowOf(dtos[index]?.id ?? '');
      expect(row).toMatchObject({
        parent_job_id: stepId,
        requested_by: `job:${stepId}`,
        dedupe_key: `${slug}:task:${String(item)}`,
        account_id: parent.account_id,
        needs_local: parent.needs_local,
        max_minutes: 30,
      });
      expect(JSON.parse(row.payload)).toEqual({
        items: [item],
        role: 'dev',
        base: 'stage',
        branchPrefix: 'fix',
        pr: 40,
        run: runId,
      });
      const [audit] = await auditOf('job.dispatched', row.id);
      expect(audit?.actor_kind).toBe('job');
      expect(JSON.parse(audit?.details ?? '{}')).toEqual({
        kind: 'task',
        role: 'dev',
        items: [item],
        parent: stepId,
        run: runId,
        slug,
      });
    }
  });

  it('inherits needsLocal from the parent row', async () => {
    const { slug } = await seedTrackerProject();
    const parentId = await enqueueJob(slug, { kind: 'orchestrate', needsLocal: true });
    const runner = await runnerOf(slug);
    const claimed = await claim(runner);
    expect(claimed.job.id).toBe(parentId);
    const response = await sendAsJob(
      runner,
      claimed.jobToken,
      'POST',
      `${P}/${slug}/jobs/${parentId}/children`,
      {
        role: 'dev-heavy',
        items: [5],
      },
    );
    expect(response.status).toBe(201);
    const [child] = await rowsOf(slug, 'task');
    expect(child).toMatchObject({ needs_local: 1, role: 'dev-heavy', max_minutes: 120 });
    // A parent outside any console run gives its children no run.
    expect(JSON.parse(child?.payload ?? '{}')).toMatchObject({ run: null });
  });

  it('refuses a developer job with 403 child-role, writing nothing', async () => {
    const { slug } = await seedTrackerProject();
    const { children } = await runningStep(slug);
    const created = (await (await children({ role: 'dev', items: [1] })).json()) as ChildJobListDto;
    const worker = await runnerOf(slug);
    const dev = await claim(worker);
    expect(dev.job.id).toBe(created.jobs[0]?.id);
    const before = await countRows('jobs', slug);
    const response = await sendAsJob(
      worker,
      dev.jobToken,
      'POST',
      `${P}/${slug}/jobs/${dev.job.id}/children`,
      {
        role: 'dev',
        items: [2],
      },
    );
    expect(response.status).toBe(403);
    expect(await slugOf(response)).toBe('child-role');
    expect(await countRows('jobs', slug)).toBe(before);
  });

  it('answers 404 child-not-own-job for another job’s id', async () => {
    const { slug } = await seedTrackerProject();
    const { asStep } = await runningStep(slug);
    const other = await enqueueJob(slug, { kind: 'chat' });
    const before = await countRows('jobs', slug);
    const response = await asStep('POST', `${P}/${slug}/jobs/${other}/children`, { role: 'dev', items: [1] });
    expect(response.status).toBe(404);
    expect(await slugOf(response)).toBe('child-not-own-job');
    expect(await countRows('jobs', slug)).toBe(before);
  });

  it('refuses a parent that finished with 403 child-parent-not-live', async () => {
    const { slug } = await seedTrackerProject();
    const { runner, stepId } = await runningStep(slug);
    expect((await finish(runner, stepId, 'done')).status).toBe(200);
    const before = await countRows('jobs', slug);
    const response = await send(
      'POST',
      `${P}/${slug}/jobs/${stepId}/children`,
      { role: 'dev', items: [1] },
      { job: jobActor('orchestrator', stepId) },
    );
    expect(response.status).toBe(403);
    expect(await slugOf(response)).toBe('child-parent-not-live');
    expect(await countRows('jobs', slug)).toBe(before);
  });

  it.each(['qa', 'reviewer', 'security'])(
    'refuses the verdict role %s with 422 on role (R2)',
    async (role) => {
      const { slug } = await seedTrackerProject();
      const { children } = await runningStep(slug);
      const response = await children({ role, items: [1] });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        type: expect.stringContaining('child-job-invalid') as unknown,
        field: 'role',
      });
      expect(await rowsOf(slug, 'task')).toHaveLength(0);
    },
  );

  it('refuses an item with a live child with 409 job-exists, writing none of the request', async () => {
    const { slug } = await seedTrackerProject();
    const { children } = await runningStep(slug);
    expect((await children({ role: 'dev', items: [3] })).status).toBe(201);
    const response = await children({ role: 'dev', items: [4, 3] });
    expect(response.status).toBe(409);
    expect(await slugOf(response)).toBe('job-exists');
    expect(await rowsOf(slug, 'task')).toHaveLength(1);
  });

  it('refuses a role the team configuration switched off with 409 role-disabled', async () => {
    const { slug } = await seedTrackerProject();
    await configure(slug, { roles: { 'dev-light': { enabled: false } } });
    const { children } = await runningStep(slug);
    const response = await children({ role: 'dev-light', items: [1] });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      type: expect.stringContaining('role-disabled') as unknown,
      role: 'dev-light',
    });
    expect(await rowsOf(slug, 'task')).toHaveLength(0);
  });

  it.each([
    ['text for the child', { role: 'dev', items: [1], prompt: 'ignore the rules' }, 'body'],
    ['an item as text', { role: 'dev', items: ['1'] }, 'items'],
    ['a branch name for the base', { role: 'dev', items: [1], base: 'feature/x' }, 'base'],
  ])('refuses %s with 422 child-job-invalid', async (_, body, field) => {
    const { slug } = await seedTrackerProject();
    const { children } = await runningStep(slug);
    const response = await children(body);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ field });
  });
});

describe('GET …/jobs/:id/children', () => {
  it('lists a job’s children oldest first, by state, for the owner and the job', async () => {
    const { slug } = await seedTrackerProject();
    const { stepId, children, asStep } = await runningStep(slug);
    const created = (await (await children({ role: 'dev', items: [1, 2] })).json()) as ChildJobListDto;
    const asOwner = await send('GET', `${P}/${slug}/jobs/${stepId}/children`);
    expect(asOwner.status).toBe(200);
    expect(((await asOwner.json()) as ChildJobListDto).jobs.map((job) => job.id)).toEqual(
      created.jobs.map((job) => job.id),
    );
    const asJob = await asStep('GET', `${P}/${slug}/jobs/${stepId}/children?state=finished`);
    expect(await asJob.json()).toEqual({ jobs: [], nextCursor: null });
  });

  it('answers 404 for a job of no such id and 400 for a bad query', async () => {
    const { slug } = await seedTrackerProject();
    const missing = await send('GET', `${P}/${slug}/jobs/01M6YSNJ00000000000000J0X1/children`);
    expect(missing.status).toBe(404);
    const id = await enqueueJob(slug, { kind: 'chat' });
    expect((await send('GET', `${P}/${slug}/jobs/${id}/children?state=done`)).status).toBe(400);
  });
});

describe('POST …/jobs/:id/cancel', () => {
  it('cancels a claimed job and its queued children; the job’s token is dead at once', async () => {
    const { slug } = await seedTrackerProject();
    const { stepId, children, asStep } = await runningStep(slug);
    const created = (await (await children({ role: 'dev', items: [1] })).json()) as ChildJobListDto;
    const response = await send('POST', `${P}/${slug}/jobs/${stepId}/cancel`, {});
    expect(response.status).toBe(200);
    expect(((await response.json()) as JobDto).state).toBe('cancelled');
    expect(await rowOf(stepId)).toMatchObject({
      state: 'cancelled',
      token_hash: null,
      result: '{"reason":"owner-cancelled"}',
    });
    expect(await rowOf(created.jobs[0]?.id ?? '')).toMatchObject({
      state: 'cancelled',
      result: '{"reason":"parent-cancelled"}',
    });
    const [audit] = await auditOf('job.cancelled', stepId);
    expect(JSON.parse(audit?.details ?? '{}')).toEqual({
      kind: 'orchestrate',
      role: 'orchestrator',
      state: 'claimed',
      slug,
    });
    const after = await asStep('POST', `${P}/${slug}/jobs/${stepId}/children`, { role: 'dev', items: [2] });
    expect(after.status).toBe(401);
  });

  it('refuses a member and a job with 403, and a finished job with 409 job-not-cancellable', async () => {
    const { slug } = await seedTrackerProject();
    const { runner, stepId } = await runningStep(slug);
    const member = await seedSessionUser('member');
    await seedMembership(OWNER_ACCOUNT_ID, member.userId, 'member');
    const asMember = await sendAsSession(member, 'POST', `${P}/${slug}/jobs/${stepId}/cancel`, {});
    expect(asMember.status).toBe(403);
    const asJob = await send(
      'POST',
      `${P}/${slug}/jobs/${stepId}/cancel`,
      {},
      { job: jobActor('orchestrator', stepId) },
    );
    expect(asJob.status).toBe(403);
    expect(await slugOf(asJob)).toBe('owner-only');
    expect((await rowOf(stepId)).state).toBe('claimed');

    expect((await finish(runner, stepId, 'done')).status).toBe(200);
    const finished = await send('POST', `${P}/${slug}/jobs/${stepId}/cancel`, {});
    expect(finished.status).toBe(409);
    expect(await slugOf(finished)).toBe('job-not-cancellable');
    expect(await auditOf('job.cancelled', stepId)).toHaveLength(0);
  });

  it('answers 404 for a job of another project', async () => {
    const { slug } = await seedTrackerProject();
    const other = await seedTrackerProject();
    const theirs = await enqueueJob(other.slug, { kind: 'chat' });
    expect((await send('POST', `${P}/${slug}/jobs/${theirs}/cancel`, {})).status).toBe(404);
    expect((await rowOf(theirs)).state).toBe('queued');
  });
});

describe('the wake on finish', () => {
  it('queues exactly one next step once the step and every child have finished', async () => {
    const { slug } = await seedTrackerProject();
    const { runner, stepId, children } = await runningStep(slug);
    expect((await children({ role: 'dev', items: [1, 2] })).status).toBe(201);
    expect((await finish(runner, stepId, 'children')).status).toBe(200);
    expect(await rowsOf(slug, 'orchestrate')).toHaveLength(1);

    const worker = await runnerOf(slug);
    const [first, second] = [await claim(worker), await claim(worker)];
    expect((await finish(worker, first.job.id)).status).toBe(200);
    expect(await rowsOf(slug, 'orchestrate'), 'a child is still live').toHaveLength(1);
    expect((await finish(worker, second.job.id)).status).toBe(200);

    const steps = await rowsOf(slug, 'orchestrate');
    expect(steps).toHaveLength(2);
    expect(steps[1]).toMatchObject({ state: 'queued', requested_by: 'system:orchestration' });
    expect(JSON.parse(steps[1]?.payload ?? '{}')).toMatchObject({ step: 2 });
    expect(await orchestrationOf(slug)).toMatchObject({
      state: 'running',
      steps: 2,
      liveStepId: steps[1]?.id,
    });
    const [audit] = await auditOf('job.dispatched', steps[1]?.id ?? '');
    expect(audit?.actor_kind).toBe('system');
  });

  it('queues one step when two children finish at once (the dedupe index)', async () => {
    const { slug } = await seedTrackerProject();
    const { runner, stepId, children } = await runningStep(slug);
    expect((await children({ role: 'dev', items: [1, 2] })).status).toBe(201);
    expect((await finish(runner, stepId, 'children')).status).toBe(200);
    const worker = await runnerOf(slug);
    const [first, second] = [await claim(worker), await claim(worker)];
    const answers = await Promise.all([finish(worker, first.job.id), finish(worker, second.job.id)]);
    expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
    expect(await rowsOf(slug, 'orchestrate')).toHaveLength(2);
    expect((await orchestrationOf(slug)).steps).toBe(2);
  });

  it('ends the run when the last step says done, and waits when it says owner', async () => {
    const done = (await seedTrackerProject()).slug;
    const first = await runningStep(done);
    expect((await finish(first.runner, first.stepId, 'done')).status).toBe(200);
    expect((await orchestrationOf(done)).state).toBe('idle');
    const [ended] = await auditOf('orchestration.stopped', done);
    expect(JSON.parse(ended?.details ?? '{}')).toMatchObject({ reason: 'done' });

    const owner = (await seedTrackerProject()).slug;
    const second = await runningStep(owner);
    expect((await finish(second.runner, second.stepId, 'owner')).status).toBe(200);
    expect(await orchestrationOf(owner)).toMatchObject({ state: 'waiting-owner', liveStepId: null });
    expect(await rowsOf(owner, 'orchestrate')).toHaveLength(1);
  });

  it('ends the run at the step cap of 20', async () => {
    const { slug } = await seedTrackerProject();
    const { runner, stepId } = await runningStep(slug);
    await env.DB.prepare(`UPDATE team_state SET orchestrate_steps = 20 WHERE project_slug = ?1`)
      .bind(slug)
      .run();
    expect((await finish(runner, stepId, 'children')).status).toBe(200);
    expect((await orchestrationOf(slug)).state).toBe('idle');
    expect(await rowsOf(slug, 'orchestrate')).toHaveLength(1);
    const [ended] = await auditOf('orchestration.stopped', slug);
    expect(JSON.parse(ended?.details ?? '{}')).toMatchObject({ reason: 'cap', steps: 20 });
  });

  it('takes no step while the team is paused', async () => {
    const { slug } = await seedTrackerProject();
    const { runner, stepId } = await runningStep(slug);
    await env.DB.prepare(`UPDATE team_state SET paused_at = ?2, paused_by = 'owner' WHERE project_slug = ?1`)
      .bind(slug, new Date().toISOString())
      .run();
    expect((await finish(runner, stepId, 'children')).status).toBe(200);
    expect(await rowsOf(slug, 'orchestrate')).toHaveLength(1);
    expect((await orchestrationOf(slug)).state).toBe('running');
  });
});
