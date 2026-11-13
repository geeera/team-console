import { env } from 'cloudflare:test';
import { OWNER_ACCOUNT_ID, type ClaimResponse, type RunnerListDto } from '@shared/contracts';
import { enqueueJob, enrolRunner, sendAsRunner, type TestRunner } from '../testing/runner-kit';
import { seedAccountProject, seedSessionUser, sendAsSession, type SessionUser } from '../testing/session-kit';
import { seedTrackerProject, send, slugOf } from '../testing/tracker-kit';
import type { RunnerPauseResponse } from './runner-pause';

// #571, ADR 0008 decision 9: the runner mirrors its usage-budget pause; the claim skips a paused runner and caps one
// at `capabilities.maxConcurrency` (threat model C4 "rogue runner"), and a paused runner of account A changes nothing
// for account B (C9).

const PAUSE = '/api/v1/runner/pause';
const RESUME = '/api/v1/runner/resume';
const CLAIM = '/api/v1/runner/jobs/claim';

/** Slot jobs are one per kind per project (the overlap guard), so specs that queue several use one of each. */
const SLOT_KINDS = ['slot-pm', 'slot-dev', 'slot-qa'] as const;

const inMinutes = (minutes: number): string => new Date(Date.now() + minutes * 60_000).toISOString();

async function claim(runner: TestRunner): Promise<ClaimResponse | null> {
  const response = await sendAsRunner(runner, 'POST', CLAIM, {});
  if (response.status === 204) {
    return null;
  }
  expect(response.status).toBe(200);
  return (await response.json()) as ClaimResponse;
}

async function pause(runner: TestRunner, body: unknown): Promise<Response> {
  return sendAsRunner(runner, 'POST', PAUSE, body);
}

async function listed(accountId: string, runnerId: string, as?: SessionUser): Promise<RunnerListDto['runners'][number] | undefined> {
  const path = `/api/v1/accounts/${accountId}/runners`;
  const response = as === undefined ? await send('GET', path) : await sendAsSession(as, 'GET', path);
  expect(response.status).toBe(200);
  return ((await response.json()) as RunnerListDto).runners.find((runner) => runner.id === runnerId);
}

describe('POST /api/v1/runner/pause and /resume', () => {
  it('pauses the runner: the claim skips it, Settings › Runners shows reason and until, resume lifts it', async () => {
    const project = await seedTrackerProject();
    const runner = await enrolRunner(OWNER_ACCOUNT_ID, { allowedProjects: [project.slug] });
    await enqueueJob(project.slug);
    const until = inMinutes(90);

    const paused = await pause(runner, { reason: 'usage-limit', until });
    expect(paused.status).toBe(200);
    expect(((await paused.json()) as RunnerPauseResponse).pause).toEqual({ reason: 'usage-limit', until });
    expect(await claim(runner)).toBeNull();
    expect((await listed(OWNER_ACCOUNT_ID, runner.id))?.pause).toEqual({ reason: 'usage-limit', until });
    const audit = await env.DB.prepare(`SELECT actor_kind, actor, details FROM audit_events WHERE kind = 'runner.paused' AND target = ?1`)
      .bind(runner.id)
      .first<{ actor_kind: string; actor: string; details: string }>();
    expect(audit).toMatchObject({ actor_kind: 'runner', actor: runner.id });
    // Ids and enums only in an audit row (CLAUDE.md).
    expect(JSON.parse(audit?.details ?? '{}')).toEqual({ reason: 'usage-limit' });

    // A repeated post (a restart mirroring state.json) answers the same and audits nothing more.
    expect((await pause(runner, { reason: 'usage-limit', until })).status).toBe(200);
    const audits = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'runner.paused' AND target = ?1`)
      .bind(runner.id)
      .first<{ n: number }>();
    expect(audits?.n).toBe(1);

    const resumed = await sendAsRunner(runner, 'POST', RESUME, {});
    expect(resumed.status).toBe(200);
    expect(((await resumed.json()) as RunnerPauseResponse).pause).toBeNull();
    expect((await listed(OWNER_ACCOUNT_ID, runner.id))?.pause).toBeNull();
    expect((await claim(runner))?.job.projectSlug).toBe(project.slug);
    // Resuming a runner that is not paused is a no-op, not an error.
    expect((await sendAsRunner(runner, 'POST', RESUME, {})).status).toBe(200);
  });

  it('shows no pause once until has passed, and the claim takes the runner again', async () => {
    const project = await seedTrackerProject();
    const runner = await enrolRunner(OWNER_ACCOUNT_ID, { allowedProjects: [project.slug] });
    await enqueueJob(project.slug);
    expect((await pause(runner, { reason: 'rate-limit', until: inMinutes(5) })).status).toBe(200);
    expect(await claim(runner)).toBeNull();
    // Time passes: the row keeps the old pause, which no longer counts.
    await env.DB.prepare(`UPDATE runners SET paused_until = '2026-01-01T00:00:00.000Z' WHERE id = ?1`).bind(runner.id).run();
    expect((await listed(OWNER_ACCOUNT_ID, runner.id))?.pause).toBeNull();
    expect((await claim(runner))?.job.projectSlug).toBe(project.slug);
  });

  it.each([
    ['an unknown reason', { reason: 'tired', until: inMinutes(30) }, 'reason'],
    ['no reason', { until: inMinutes(30) }, 'reason'],
    ['until more than 24 hours ahead', { reason: 'usage-limit', until: inMinutes(24 * 60 + 5) }, 'until'],
    ['until in the past', { reason: 'usage-limit', until: inMinutes(-5) }, 'until'],
    ['until that is not a UTC timestamp', { reason: 'usage-limit', until: 'tomorrow' }, 'until'],
    ['a runner id in the body', { reason: 'manual', until: inMinutes(30), runnerId: '01M6YSNJ0000000000000NOPE1' }, 'body'],
  ])('refuses %s with 422 and writes nothing', async (_, body, field) => {
    const runner = await enrolRunner(OWNER_ACCOUNT_ID);
    const response = await pause(runner, body);
    expect(response.status).toBe(422);
    expect(await slugOf(response)).toBe('runner-pause-invalid');
    expect(((await response.json()) as { field: string }).field).toBe(field);
    expect((await listed(OWNER_ACCOUNT_ID, runner.id))?.pause).toBeNull();
  });

  it('refuses a revoked runner at the door', async () => {
    const runner = await enrolRunner(OWNER_ACCOUNT_ID);
    expect((await send('POST', `/api/v1/accounts/${OWNER_ACCOUNT_ID}/runners/${runner.id}/revoke`, {})).status).toBe(200);
    const response = await pause(runner, { reason: 'manual', until: inMinutes(30) });
    expect(response.status).toBe(401);
    expect((await sendAsRunner(runner, 'POST', RESUME, {})).status).toBe(401);
  });

  it('a paused runner of account A changes nothing for account B (two-account)', async () => {
    const other = await seedSessionUser('owner');
    const theirs = await seedAccountProject(other.account, { tracker: 'console' });
    const theirRunner = await enrolRunner(other.account.id, { as: other, allowedProjects: [theirs.slug] });
    await enqueueJob(theirs.slug, {}, other);

    const mine = await seedTrackerProject();
    const myRunner = await enrolRunner(OWNER_ACCOUNT_ID, { allowedProjects: [mine.slug] });
    await enqueueJob(mine.slug);
    expect((await pause(myRunner, { reason: 'usage-limit', until: inMinutes(60) })).status).toBe(200);

    expect(await claim(myRunner)).toBeNull();
    expect((await claim(theirRunner))?.job.projectSlug).toBe(theirs.slug);
    expect((await listed(other.account.id, theirRunner.id, other))?.pause).toBeNull();
    // A's runner is never in B's list, paused or not.
    expect(await listed(other.account.id, myRunner.id, other)).toBeUndefined();
    const theirAudits = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'runner.paused' AND account_id = ?1`)
      .bind(other.account.id)
      .first<{ n: number }>();
    expect(theirAudits?.n).toBe(0);
  });
});

describe('the claim and maxConcurrency (threat model C4 "rogue runner")', () => {
  it('a runner at maxConcurrency 1 claims no second job until it finishes the first', async () => {
    const project = await seedTrackerProject();
    const runner = await enrolRunner(OWNER_ACCOUNT_ID, { allowedProjects: [project.slug] });
    const first = await enqueueJob(project.slug, { kind: 'slot-dev' });
    const second = await enqueueJob(project.slug, { kind: 'slot-qa' });
    expect((await claim(runner))?.job.id).toBe(first);
    expect(await claim(runner)).toBeNull();
    const row = await env.DB.prepare(`SELECT state, runner_id FROM jobs WHERE id = ?1`).bind(second).first<{ state: string; runner_id: string | null }>();
    expect(row).toEqual({ state: 'queued', runner_id: null });

    const finish = await sendAsRunner(runner, 'POST', `/api/v1/runner/jobs/${first}/finish`, { result: 'finished', summary: 'ok' });
    expect(finish.status).toBe(200);
    expect((await claim(runner))?.job.id).toBe(second);
  });

  it('a runner enrolled with maxConcurrency 2 holds two jobs and no third', async () => {
    const project = await seedTrackerProject();
    const runner = await enrolRunner(OWNER_ACCOUNT_ID, {
      allowedProjects: [project.slug],
      enrol: { capabilities: { local: true, maxConcurrency: 2 } },
    });
    for (const kind of SLOT_KINDS) {
      await enqueueJob(project.slug, { kind });
    }
    expect(await claim(runner)).not.toBeNull();
    expect(await claim(runner)).not.toBeNull();
    expect(await claim(runner)).toBeNull();
  });

  it('two runners at maxConcurrency 1 polling at once take two jobs, one each', async () => {
    const project = await seedTrackerProject();
    const mac = await enrolRunner(OWNER_ACCOUNT_ID, { allowedProjects: [project.slug] });
    const vps = await enrolRunner(OWNER_ACCOUNT_ID, { allowedProjects: [project.slug] });
    await enqueueJob(project.slug, { kind: 'slot-dev' });
    await enqueueJob(project.slug, { kind: 'slot-qa' });
    const claims = await Promise.all([claim(mac), claim(vps), claim(mac), claim(vps)]);
    const taken = claims.filter((outcome): outcome is ClaimResponse => outcome !== null);
    expect(taken.map((outcome) => outcome.job.runnerId).sort()).toEqual([mac.id, vps.id].sort());
  });
});

describe('the failure streak and limit failures', () => {
  it('a job failed on a usage or rate limit does not count toward the streak; a plain failure does', async () => {
    const project = await seedTrackerProject();
    const runner = await enrolRunner(OWNER_ACCOUNT_ID, { allowedProjects: [project.slug] });
    const finishAs = async (metrics: Record<string, unknown>): Promise<void> => {
      await enqueueJob(project.slug);
      const claimed = await claim(runner);
      expect(claimed).not.toBeNull();
      const response = await sendAsRunner(runner, 'POST', `/api/v1/runner/jobs/${claimed?.job.id ?? ''}/finish`, {
        result: 'failed',
        summary: 'stopped',
        metrics,
      });
      expect(response.status).toBe(200);
    };
    await finishAs({ reason: 'exit', exitCode: 1 });
    await finishAs({ reason: 'exit', exitCode: 1 });
    await finishAs({ reason: 'usage-limit', retryAt: inMinutes(60) });
    await finishAs({ reason: 'rate-limit', retryAt: inMinutes(10) });
    const state = await env.DB.prepare(`SELECT paused_at, failed_streak FROM team_state WHERE project_slug = ?1`)
      .bind(project.slug)
      .first<{ paused_at: string | null; failed_streak: number }>();
    expect(state).toEqual({ paused_at: null, failed_streak: 2 });
  });
});
