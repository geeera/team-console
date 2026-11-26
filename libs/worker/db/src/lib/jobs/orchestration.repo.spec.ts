import { env } from 'cloudflare:test';
import { ORCHESTRATE_MAX_STEPS } from '@shared/contracts';
import type { NewAuditEvent } from '../accounts/audit.repo';
import { JobsRepo, type NewJob } from './jobs.repo';
import { OrchestrationRepo } from './orchestration.repo';
import { TeamStateRepo } from './team-state.repo';

// #1039 (ADR 0010 decisions 1–3): the run lock and the job writes that move with it, directly against D1.

const ACCOUNT = '01M6YSNJ00000000000000RCA1';
const T0 = '2026-11-26T10:00:00.000Z';
const T1 = '2026-11-26T10:05:00.000Z';
const LEASE = '2026-11-26T10:30:00.000Z';

let counter = 0;
const ulid = (tag: string): string => {
  counter += 1;
  return `01M6YSNJ0000000000${tag}${String(counter).padStart(6, '0')}`.slice(0, 26);
};
const audit = (kind: NewAuditEvent['kind'], target: string | null = null): NewAuditEvent => ({
  accountId: ACCOUNT,
  at: T0,
  actorKind: 'system',
  actor: 'spec',
  kind,
  target,
});

const repo = new OrchestrationRepo(env.DB);
const jobs = new JobsRepo(env.DB);
const teamState = new TeamStateRepo(env.DB);

beforeAll(async () => {
  await env.DB.prepare(
    `INSERT INTO accounts (id, slug, name, entitlements, created_at) VALUES (?1, 'rc-a', 'A', '{"max_concurrency":32}', ?2)`,
  )
    .bind(ACCOUNT, T0)
    .run();
});

async function project(): Promise<string> {
  counter += 1;
  const slug = `rc-${String(counter)}`;
  await env.DB.prepare(
    `INSERT INTO projects (slug, repo, display_name, cache_epoch, added_at, account_id) VALUES (?1, ?2, ?1, 0, ?3, ?4)`,
  )
    .bind(slug, `acme/${slug}`, T0, ACCOUNT)
    .run();
  return slug;
}

async function runner(slug: string): Promise<string> {
  const id = ulid('RN');
  await env.DB.prepare(
    `INSERT INTO runners (id, account_id, name, public_key_jwk, capabilities, isolation, allowed_projects, version, enrolled_at, project_scope)
     VALUES (?1, ?2, 'r', ?3, '{"local":true,"maxConcurrency":8}', 'user', ?4, '0.1.0', ?5, 'selected')`,
  )
    .bind(
      id,
      ACCOUNT,
      JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: 'x'.repeat(43) }),
      JSON.stringify([slug]),
      T0,
    )
    .run();
  return id;
}

function newJob(slug: string, overrides: Partial<NewJob> = {}): NewJob {
  return {
    id: ulid('JB'),
    accountId: ACCOUNT,
    projectSlug: slug,
    kind: 'task',
    role: 'dev',
    payload: { items: [] },
    priority: 2,
    requestedBy: 'spec',
    dedupeKey: null,
    needsLocal: false,
    maxMinutes: 90,
    at: T0,
    ...overrides,
  };
}

async function enqueued(slug: string, overrides: Partial<NewJob> = {}): Promise<string> {
  const job = newJob(slug, overrides);
  expect(await jobs.enqueue(job, audit('job.dispatched', job.id))).toBe('ok');
  return job.id;
}

let tokens = 0;
/** As the claim leaves a job: its runner, a lease and a token hash (0022's CHECK asks for all three). */
async function claimed(
  jobId: string,
  runnerId: string,
  state: 'claimed' | 'running' = 'running',
): Promise<void> {
  tokens += 1;
  await env.DB.prepare(
    `UPDATE jobs SET state = ?2, runner_id = ?3, lease_until = ?4, token_hash = ?5, claimed_at = ?6 WHERE id = ?1`,
  )
    .bind(jobId, state, runnerId, LEASE, `ab${tokens.toString(16)}`.padEnd(64, '0'), T0)
    .run();
}

interface Row {
  readonly state: string;
  readonly token_hash: string | null;
  readonly lease_until: string | null;
  readonly result: string | null;
}

async function rowOf(id: string): Promise<Row> {
  const row = await env.DB.prepare(`SELECT state, token_hash, lease_until, result FROM jobs WHERE id = ?1`)
    .bind(id)
    .first<Row>();
  if (row === null) {
    throw new Error(`no job ${id}`);
  }
  return row;
}

async function auditCount(kind: string, target: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE kind = ?1 AND target = ?2`)
    .bind(kind, target)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function jobCount(slug: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE project_slug = ?1`)
    .bind(slug)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

function step(slug: string, runId: string, n: number, overrides: Partial<NewJob> = {}): NewJob {
  return newJob(slug, {
    kind: 'orchestrate',
    role: 'orchestrator',
    payload: { items: [], run: runId, step: n },
    priority: 1,
    requestedBy: 'system:orchestration',
    dedupeKey: `${slug}:orchestrator`,
    ...overrides,
  });
}

/** A started run: the lock taken and step 1 queued. */
async function started(slug: string): Promise<{ runId: string; stepId: string }> {
  const runId = ulid('RR');
  const first = step(slug, runId, 1);
  expect(
    await repo.start(
      slug,
      runId,
      first,
      audit('orchestration.started', slug),
      audit('job.dispatched', first.id),
    ),
  ).toBe('started');
  return { runId, stepId: first.id };
}

describe('TeamStateRepo.orchestrationOf', () => {
  it('reads idle for a project without a team_state row, and the run once one starts', async () => {
    const slug = await project();
    expect(await teamState.orchestrationOf(slug)).toEqual({ runId: null, steps: 0 });
    const { runId } = await started(slug);
    expect(await teamState.orchestrationOf(slug)).toEqual({ runId, steps: 1 });
  });
});

describe('OrchestrationRepo.start', () => {
  it('takes the lock and queues the first step, with both audit rows, in one batch', async () => {
    const slug = await project();
    const { runId, stepId } = await started(slug);
    const job = await jobs.findById(stepId);
    expect(job).toMatchObject({
      kind: 'orchestrate',
      role: 'orchestrator',
      state: 'queued',
      dedupeKey: `${slug}:orchestrator`,
      payload: { items: [], run: runId, step: 1 },
    });
    expect(await auditCount('orchestration.started', slug)).toBe(1);
    expect(await auditCount('job.dispatched', stepId)).toBe(1);
  });

  it('refuses a second run while one holds the lock, writing nothing', async () => {
    const slug = await project();
    const { runId } = await started(slug);
    const other = ulid('RR');
    const second = step(slug, other, 1, { dedupeKey: null });
    const before = await jobCount(slug);
    expect(
      await repo.start(
        slug,
        other,
        second,
        audit('orchestration.started', 'second'),
        audit('job.dispatched', second.id),
      ),
    ).toBe('orchestration-active');
    expect(await jobCount(slug)).toBe(before);
    expect(await auditCount('orchestration.started', 'second')).toBe(0);
    expect(await auditCount('job.dispatched', second.id)).toBe(0);
    expect((await teamState.orchestrationOf(slug)).runId).toBe(runId);
  });

  it('is all or nothing: a live orchestrator job holding the key leaves the lock free', async () => {
    const slug = await project();
    await enqueued(slug, { kind: 'slot-dev', role: 'orchestrator', dedupeKey: `${slug}:orchestrator` });
    const runId = ulid('RR');
    const first = step(slug, runId, 1);
    expect(
      await repo.start(
        slug,
        runId,
        first,
        audit('orchestration.started', slug),
        audit('job.dispatched', first.id),
      ),
    ).toBe('job-exists');
    expect(await teamState.orchestrationOf(slug)).toEqual({ runId: null, steps: 0 });
    expect(await auditCount('orchestration.started', slug)).toBe(0);
    expect(await jobs.findById(first.id)).toBeNull();
  });

  it('keeps the pause and the streak of an existing team_state row', async () => {
    const slug = await project();
    await env.DB.prepare(
      `INSERT INTO team_state (project_slug, failed_streak, updated_at) VALUES (?1, 2, ?2)`,
    )
      .bind(slug, T0)
      .run();
    await started(slug);
    expect((await teamState.get(slug)).failedStreak).toBe(2);
  });
});

describe('OrchestrationRepo.stop', () => {
  it('clears the run and cancels its live step, children and step reviews in one batch, tokens cleared', async () => {
    const slug = await project();
    const runnerId = await runner(slug);
    const { runId, stepId } = await started(slug);
    await claimed(stepId, runnerId);
    const child = (n: number) =>
      enqueued(slug, {
        payload: { items: [n], run: runId },
        parentJobId: stepId,
        dedupeKey: `${slug}:task:${String(n)}`,
      });
    const queuedChild = await child(1);
    const claimedChild = await child(2);
    const runningChild = await child(3);
    const finishedChild = await child(4);
    await claimed(claimedChild, runnerId, 'claimed');
    await claimed(runningChild, runnerId, 'running');
    await env.DB.prepare(`UPDATE jobs SET state = 'finished', finished_at = ?2 WHERE id = ?1`)
      .bind(finishedChild, T0)
      .run();
    const review = await enqueued(slug, {
      kind: 'review',
      role: 'qa',
      payload: { pr: 5 },
      parentJobId: stepId,
    });
    const unrelated = await enqueued(slug, { kind: 'chat', role: 'pm' });

    const outcome = await repo.stop(slug, runId, T1, audit('orchestration.stopped', slug));
    expect(outcome).toEqual({ stopped: true, cancelled: 5 });
    for (const id of [stepId, queuedChild, claimedChild, runningChild, review]) {
      expect(await rowOf(id), id).toEqual({
        state: 'cancelled',
        token_hash: null,
        lease_until: null,
        result: '{"reason":"orchestration-stopped"}',
      });
    }
    expect((await rowOf(finishedChild)).state).toBe('finished');
    expect((await rowOf(unrelated)).state).toBe('queued');
    expect(await teamState.orchestrationOf(slug)).toEqual({ runId: null, steps: 0 });
    expect(await auditCount('orchestration.stopped', slug)).toBe(1);
  });

  it('writes nothing for a run that is no longer the project’s', async () => {
    const slug = await project();
    const { runId, stepId } = await started(slug);
    expect((await repo.stop(slug, ulid('RR'), T1, audit('orchestration.stopped', 'stale'))).stopped).toBe(
      false,
    );
    expect((await rowOf(stepId)).state).toBe('queued');
    expect(await auditCount('orchestration.stopped', 'stale')).toBe(0);
    expect((await teamState.orchestrationOf(slug)).runId).toBe(runId);
  });
});

describe('OrchestrationRepo.wake', () => {
  it('queues the next step and counts it, in one batch', async () => {
    const slug = await project();
    const { runId, stepId } = await started(slug);
    await env.DB.prepare(`UPDATE jobs SET state = 'finished', finished_at = ?2 WHERE id = ?1`)
      .bind(stepId, T0)
      .run();
    const next = step(slug, runId, 2);
    expect(await repo.wake(slug, runId, next, audit('job.dispatched', next.id))).toBe('enqueued');
    expect(await teamState.orchestrationOf(slug)).toEqual({ runId, steps: 2 });
    expect(await auditCount('job.dispatched', next.id)).toBe(1);
    expect(await repo.lastStepOf(slug, runId)).toMatchObject({ id: next.id, state: 'queued' });
  });

  it('meets a racing wake at the dedupe index: one step, one count', async () => {
    const slug = await project();
    const { runId, stepId } = await started(slug);
    await env.DB.prepare(`UPDATE jobs SET state = 'finished', finished_at = ?2 WHERE id = ?1`)
      .bind(stepId, T0)
      .run();
    const [a, b] = [step(slug, runId, 2), step(slug, runId, 2)];
    const outcomes = await Promise.all([
      repo.wake(slug, runId, a, audit('job.dispatched', a.id)),
      repo.wake(slug, runId, b, audit('job.dispatched', b.id)),
    ]);
    expect([...outcomes].sort()).toEqual(['enqueued', 'job-exists']);
    expect(await teamState.orchestrationOf(slug)).toEqual({ runId, steps: 2 });
    expect((await auditCount('job.dispatched', a.id)) + (await auditCount('job.dispatched', b.id))).toBe(1);
  });

  it('enqueues nothing for a run that moved, and nothing past the cap', async () => {
    const slug = await project();
    const { runId, stepId } = await started(slug);
    await env.DB.prepare(`UPDATE jobs SET state = 'finished', finished_at = ?2 WHERE id = ?1`)
      .bind(stepId, T0)
      .run();
    const stale = step(slug, ulid('RR'), 2);
    expect(
      await repo.wake(slug, stale.payload['run'] as string, stale, audit('job.dispatched', stale.id)),
    ).toBe('run-moved');
    await env.DB.prepare(`UPDATE team_state SET orchestrate_steps = ?2 WHERE project_slug = ?1`)
      .bind(slug, ORCHESTRATE_MAX_STEPS)
      .run();
    const capped = step(slug, runId, ORCHESTRATE_MAX_STEPS + 1);
    expect(await repo.wake(slug, runId, capped, audit('job.dispatched', capped.id))).toBe('run-moved');
    expect(await jobs.findById(capped.id)).toBeNull();
    expect(await auditCount('job.dispatched', capped.id)).toBe(0);
    expect((await teamState.orchestrationOf(slug)).steps).toBe(ORCHESTRATE_MAX_STEPS);
  });
});

describe('OrchestrationRepo.end', () => {
  it('clears the run once, with its audit row', async () => {
    const slug = await project();
    const { runId } = await started(slug);
    expect(await repo.end(slug, runId, T1, audit('orchestration.stopped', `${slug}:end`))).toBe(true);
    expect(await repo.end(slug, runId, T1, audit('orchestration.stopped', `${slug}:end`))).toBe(false);
    expect(await auditCount('orchestration.stopped', `${slug}:end`)).toBe(1);
    expect(await teamState.orchestrationOf(slug)).toEqual({ runId: null, steps: 0 });
  });
});

describe('OrchestrationRepo.cancel', () => {
  it('cancels a live job and its queued children, its token dead, a running child kept', async () => {
    const slug = await project();
    const runnerId = await runner(slug);
    const parent = await enqueued(slug, { kind: 'orchestrate', role: 'orchestrator' });
    await claimed(parent, runnerId);
    const queuedChild = await enqueued(slug, { parentJobId: parent });
    const runningChild = await enqueued(slug, { parentJobId: parent });
    await claimed(runningChild, runnerId);

    expect(await repo.cancel(slug, parent, T1, audit('job.cancelled', parent))).toEqual({
      cancelled: true,
      children: 1,
    });
    expect(await rowOf(parent)).toEqual({
      state: 'cancelled',
      token_hash: null,
      lease_until: null,
      result: '{"reason":"owner-cancelled"}',
    });
    expect(await rowOf(queuedChild)).toMatchObject({
      state: 'cancelled',
      result: '{"reason":"parent-cancelled"}',
    });
    expect((await rowOf(runningChild)).state).toBe('running');
    expect(await auditCount('job.cancelled', parent)).toBe(1);
  });

  it('refuses a job that already ended, or another project’s, writing nothing', async () => {
    const slug = await project();
    const other = await project();
    const done = await enqueued(slug);
    await env.DB.prepare(`UPDATE jobs SET state = 'finished', finished_at = ?2 WHERE id = ?1`)
      .bind(done, T0)
      .run();
    const child = await enqueued(slug, { parentJobId: done });
    expect((await repo.cancel(slug, done, T1, audit('job.cancelled', done))).cancelled).toBe(false);
    const theirs = await enqueued(other);
    expect((await repo.cancel(slug, theirs, T1, audit('job.cancelled', theirs))).cancelled).toBe(false);
    expect((await rowOf(child)).state).toBe('queued');
    expect((await rowOf(theirs)).state).toBe('queued');
    expect(await auditCount('job.cancelled', done)).toBe(0);
  });
});

describe('the run reads', () => {
  it('lists the run’s live jobs, its last step, its child counts and a job’s children by page', async () => {
    const slug = await project();
    const runnerId = await runner(slug);
    const { runId, stepId } = await started(slug);
    const child = (n: number) =>
      enqueued(slug, {
        payload: { items: [n], run: runId },
        parentJobId: stepId,
        dedupeKey: `${slug}:task:${String(n)}`,
      });
    const ids = [await child(1), await child(2), await child(3), await child(4)];
    await claimed(ids[1] ?? '', runnerId, 'claimed');
    await env.DB.prepare(`UPDATE jobs SET state = 'finished', finished_at = ?2 WHERE id = ?1`)
      .bind(ids[2], T0)
      .run();
    await env.DB.prepare(`UPDATE jobs SET state = 'failed', finished_at = ?2 WHERE id = ?1`)
      .bind(ids[3], T0)
      .run();
    await enqueued(slug, { kind: 'chat', role: 'pm' });

    expect((await repo.liveOfRun(slug, runId)).map((job) => job.id)).toEqual([stepId, ids[0], ids[1]]);
    expect((await repo.lastStepOf(slug, runId))?.id).toBe(stepId);
    expect(await repo.childCountsOf(slug, runId)).toEqual({ queued: 1, running: 1, finished: 1, failed: 1 });
    expect(await repo.childCountsOf(slug, ulid('RR'))).toEqual({
      queued: 0,
      running: 0,
      finished: 0,
      failed: 0,
    });

    const first = await repo.childrenOf(slug, stepId, { limit: 2 });
    expect(first.map((job) => job.id)).toEqual(ids.slice(0, 3));
    const rest = await repo.childrenOf(slug, stepId, { limit: 2, after: ids[1] ?? null });
    expect(rest.map((job) => job.id)).toEqual(ids.slice(2));
    expect(
      (await repo.childrenOf(slug, stepId, { limit: 10, state: 'failed' })).map((job) => job.id),
    ).toEqual([ids[3]]);
    expect(await repo.childrenOf(await project(), stepId, { limit: 10 })).toEqual([]);
  });

  it('binds every value: a hostile requester is stored as written, never run', async () => {
    const slug = await project();
    const hostile = `job:x'); DELETE FROM jobs; --`;
    const id = await enqueued(slug, { requestedBy: hostile });
    expect((await jobs.findById(id))?.requestedBy).toBe(hostile);
    expect(await jobCount(slug)).toBe(1);
  });
});
