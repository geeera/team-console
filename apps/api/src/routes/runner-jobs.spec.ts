import { env } from 'cloudflare:test';
import { OWNER_ACCOUNT_ID, type ClaimResponse, type JobDto, type JobEventListDto } from '@shared/contracts';
import { JOB_TOKEN_PREFIX } from '@shared/redaction';
import { localEnv } from '../testing/github-kit';
import { enqueueJob, enrolRunner, sendAsJob, sendAsRunner, type TestRunner } from '../testing/runner-kit';
import { seedAccountProject, seedSessionUser, sendAsSession } from '../testing/session-kit';
import { seedTrackerProject, send, slugOf } from '../testing/tracker-kit';

// #467, ADR 0006 "Claim"/"Run"/"Report", ADR 0008 decisions 2, 8 and 12; threat model C9 ("a runner claiming
// another account's job"), C11 ("a job claims on the wrong host"), C4 ("a job outlives its lease or keeps its token").

const CLAIM = '/api/v1/runner/jobs/claim';

async function claim(runner: TestRunner): Promise<ClaimResponse | null> {
  const response = await sendAsRunner(runner, 'POST', CLAIM, {});
  if (response.status === 204) {
    expect(response.headers.get('Retry-After')).toBe('60');
    return null;
  }
  expect(response.status).toBe(200);
  return (await response.json()) as ClaimResponse;
}

async function runnerFor(slugs: readonly string[], enrol: Record<string, unknown> = {}): Promise<TestRunner> {
  return enrolRunner(OWNER_ACCOUNT_ID, { allowedProjects: slugs, enrol });
}

describe('POST /api/v1/runner/jobs/claim', () => {
  it('answers 204 with Retry-After while nothing is queued, then hands out one job with a tcj_ token and a lease', async () => {
    const project = await seedTrackerProject();
    const runner = await runnerFor([project.slug]);
    expect(await claim(runner)).toBeNull();

    const jobId = await enqueueJob(project.slug, { items: [3, 1] });
    const claimed = await claim(runner);
    expect(claimed?.job).toMatchObject({ id: jobId, state: 'claimed', runnerId: runner.id, attempt: 1, role: 'orchestrator', items: [3, 1] });
    expect(claimed?.jobToken.startsWith(JOB_TOKEN_PREFIX)).toBe(true);
    expect(claimed?.leaseSeconds).toBe(300);
    // One job, once: the next poll finds nothing, and the token is stored hashed only.
    expect(await claim(runner)).toBeNull();
    const row = await env.DB.prepare(`SELECT token_hash FROM jobs WHERE id = ?1`).bind(jobId).first<{ token_hash: string }>();
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.token_hash).not.toContain(claimed?.jobToken.slice(4, 20));
    const audit = await env.DB.prepare(`SELECT actor_kind, actor FROM audit_events WHERE kind = 'job.claimed' AND target = ?1`)
      .bind(jobId)
      .first<{ actor_kind: string; actor: string }>();
    expect(audit).toEqual({ actor_kind: 'runner', actor: runner.id });
  });

  it('never hands another account’s job to a runner, even one whose allow-list names the slug (two-account claim)', async () => {
    const other = await seedSessionUser('owner');
    const theirs = await seedAccountProject(other.account, { tracker: 'console' });
    const theirJob = await enqueueJob(theirs.slug, {}, other);
    const runner = await runnerFor([]);
    // The allow-list is written past the API's check, as a tampered row would be: the account match inside the
    // claim UPDATE still refuses it.
    await env.DB.prepare(`UPDATE runners SET allowed_projects = ?2 WHERE id = ?1`)
      .bind(runner.id, JSON.stringify([theirs.slug]))
      .run();
    expect(await claim(runner)).toBeNull();
    const row = await env.DB.prepare(`SELECT state, runner_id FROM jobs WHERE id = ?1`).bind(theirJob).first<{ state: string; runner_id: null }>();
    expect(row).toEqual({ state: 'queued', runner_id: null });
  });

  it('serves the allow-list only, skips needs_local for a remote runner and a paused project', async () => {
    const project = await seedTrackerProject();
    const outside = await runnerFor([]);
    await enqueueJob(project.slug);
    expect(await claim(outside)).toBeNull();

    const remote = await runnerFor([project.slug], { capabilities: { local: false, maxConcurrency: 1 } });
    await env.DB.prepare(`UPDATE jobs SET needs_local = 1 WHERE project_slug = ?1`).bind(project.slug).run();
    expect(await claim(remote)).toBeNull();

    const local = await runnerFor([project.slug]);
    const paused = await send('POST', `/api/v1/projects/${project.slug}/team/pause`, {});
    expect(paused.status).toBe(201);
    expect(await claim(local)).toBeNull();
    expect((await send('POST', `/api/v1/projects/${project.slug}/team/pause`, {})).status).toBe(409);
    expect((await send('POST', `/api/v1/projects/${project.slug}/team/resume`, {})).status).toBe(201);
    expect((await claim(local))?.job.projectSlug).toBe(project.slug);
  });

  describe('placement (ADR 0008 decision 12)', () => {
    it('pinned: only the named runner claims; switching the policy needs no re-enrolment', async () => {
      const project = await seedTrackerProject();
      const mac = await runnerFor([project.slug]);
      const vps = await runnerFor([project.slug]);
      await enqueueJob(project.slug);
      const pin = await send('PUT', `/api/v1/projects/${project.slug}/runner-policy`, { mode: 'pinned', runner: mac.id });
      expect(pin.status).toBe(200);
      expect(await claim(vps)).toBeNull();
      const repin = await send('PUT', `/api/v1/projects/${project.slug}/runner-policy`, { mode: 'pinned', runner: vps.id });
      expect(repin.status).toBe(200);
      expect((await claim(vps))?.job.runnerId).toBe(vps.id);
    });

    it('failover: the fallback claims only once the preferred runner is silent past offline_after_seconds', async () => {
      const project = await seedTrackerProject();
      const mac = await runnerFor([project.slug]);
      const vps = await runnerFor([project.slug]);
      await sendAsRunner(mac, 'GET', '/api/v1/runner/release');
      await enqueueJob(project.slug);
      const policy = { mode: 'failover', preferred: mac.id, fallback: [vps.id], offline_after_seconds: 300 };
      expect((await send('PUT', `/api/v1/projects/${project.slug}/runner-policy`, policy)).status).toBe(200);
      expect(await claim(vps)).toBeNull();
      await env.DB.prepare(`UPDATE runners SET last_seen_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1`).bind(mac.id).run();
      expect((await claim(vps))?.job.runnerId).toBe(vps.id);
    });

    it('the account default applies where a project has none, and a policy naming a foreign runner is refused', async () => {
      const project = await seedTrackerProject();
      const mac = await runnerFor([project.slug]);
      const vps = await runnerFor([project.slug]);
      const other = await seedSessionUser('owner');
      const foreign = await enrolRunner(other.account.id, { as: other });
      await enqueueJob(project.slug);
      const bad = await send('PUT', `/api/v1/accounts/${OWNER_ACCOUNT_ID}/runner-policy`, { mode: 'pinned', runner: foreign.id });
      expect(bad.status).toBe(422);
      expect(await slugOf(bad)).toBe('runner-policy-invalid');
      const badProject = await send('PUT', `/api/v1/projects/${project.slug}/runner-policy`, { mode: 'pinned', runner: foreign.id });
      expect(badProject.status).toBe(422);
      expect((await send('PUT', `/api/v1/accounts/${OWNER_ACCOUNT_ID}/runner-policy`, { mode: 'pinned', runner: mac.id })).status).toBe(200);
      expect(await claim(vps)).toBeNull();
      expect((await claim(mac))?.job.runnerId).toBe(mac.id);
      await send('PUT', `/api/v1/accounts/${OWNER_ACCOUNT_ID}/runner-policy`, { mode: 'any' });
      const audit = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'runner.policy-changed'`).first<{ n: number }>();
      expect(audit?.n).toBeGreaterThanOrEqual(2);
    });
  });

  it('skips a job of a suspended account and of an archived project (#490 review)', async () => {
    const other = await seedSessionUser('owner');
    const theirs = await seedAccountProject(other.account, { tracker: 'console' });
    await enqueueJob(theirs.slug, {}, other);
    const theirRunner = await enrolRunner(other.account.id, { as: other, allowedProjects: [theirs.slug] });
    await env.DB.prepare(`UPDATE accounts SET suspended_at = '2026-11-10T00:00:00.000Z' WHERE id = ?1`).bind(other.account.id).run();
    expect(await claim(theirRunner)).toBeNull();

    const project = await seedTrackerProject();
    const runner = await runnerFor([project.slug]);
    await enqueueJob(project.slug);
    await env.DB.prepare(`UPDATE projects SET archived_at = '2026-11-10T00:00:00.000Z' WHERE slug = ?1`).bind(project.slug).run();
    expect(await claim(runner)).toBeNull();
  });

  it('refuses a none-isolation runner on production', async () => {
    const project = await seedTrackerProject();
    const runner = await runnerFor([project.slug], { isolation: 'none' });
    const response = await sendAsRunner(runner, 'POST', CLAIM, {}, {
      bindings: localEnv({ ENVIRONMENT: 'production', AUTH_MODE: undefined }),
      jwt: { audience: 'team-console:production' },
    });
    expect(response.status).toBe(403);
    expect(await slugOf(response)).toBe('runner-isolation-none');
  });
});

describe('the job token (R4) and the job’s life', () => {
  it('reaches the job’s own project only with the claiming runner’s JWT, never alone or with another runner’s', async () => {
    const project = await seedTrackerProject();
    const other = await seedTrackerProject();
    const runner = await runnerFor([project.slug, other.slug]);
    const impostor = await runnerFor([project.slug]);
    await enqueueJob(project.slug);
    const { jobToken, job } = (await claim(runner)) as ClaimResponse;

    const ok = await sendAsJob(runner, jobToken, 'GET', `/api/v1/projects/${project.slug}/jobs/${job.id}`);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as JobDto).state).toBe('claimed');

    const otherProject = await sendAsJob(runner, jobToken, 'GET', `/api/v1/projects/${other.slug}/items`);
    expect(otherProject.status).toBe(404);
    expect(await slugOf(otherProject)).toBe('project-not-found');

    const alone = await send('GET', `/api/v1/projects/${project.slug}/items`, undefined, { headers: { Authorization: `Bearer ${jobToken}` } });
    expect(alone.status).toBe(401);
    expect(await slugOf(alone)).toBe('job-runner-missing');

    const mismatch = await sendAsJob(impostor, jobToken, 'GET', `/api/v1/projects/${project.slug}/items`);
    expect(mismatch.status).toBe(403);
    expect(await slugOf(mismatch)).toBe('job-runner-mismatch');

    const unknown = await sendAsJob(runner, `${JOB_TOKEN_PREFIX}${'z'.repeat(43)}`, 'GET', `/api/v1/projects/${project.slug}/items`);
    expect(unknown.status).toBe(401);
    expect(await slugOf(unknown)).toBe('job-token-invalid');

    const offMatrix = await sendAsJob(runner, jobToken, 'GET', '/api/v1/overview');
    expect(offMatrix.status).toBe(403);
  });

  it('heartbeats, streams redacted events, finishes, and the token dies with the job', async () => {
    const project = await seedTrackerProject();
    const runner = await runnerFor([project.slug]);
    const stranger = await runnerFor([project.slug]);
    await enqueueJob(project.slug);
    const { jobToken, job } = (await claim(runner)) as ClaimResponse;
    const base = `/api/v1/runner/jobs/${job.id}`;

    const beat = await sendAsRunner(runner, 'POST', `${base}/heartbeat`, {});
    expect(beat.status).toBe(200);
    expect((await sendAsRunner(stranger, 'POST', `${base}/heartbeat`, {})).status).toBe(404);

    const secret = `${JOB_TOKEN_PREFIX}${'q'.repeat(43)}`;
    const lines: string[] = [];
    const events = await sendAsRunner(runner, 'POST', `${base}/events`, {
      events: [
        { level: 'info', kind: 'started', payload: { skill: 'slot-dev' } },
        { level: 'info', kind: 'log', payload: { line: `export TC_JOB_TOKEN=${secret}` } },
      ],
    }, { logSink: (line) => lines.push(line) });
    expect(events.status).toBe(201);
    expect(await events.json()).toEqual({ lastSeq: 3, capped: false });
    expect(lines.join('\n')).not.toContain(secret);

    const read = await send('GET', `/api/v1/projects/${project.slug}/jobs/${job.id}/events`);
    const { events: stored } = (await read.json()) as JobEventListDto;
    expect(stored.map((event) => event.kind)).toEqual(['notice', 'started', 'log']);
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(JSON.stringify(stored)).toContain('[redacted:job-token]');
    expect(((await (await send('GET', `/api/v1/projects/${project.slug}/jobs/${job.id}`)).json()) as JobDto).state).toBe('running');

    const bad = await sendAsRunner(runner, 'POST', `${base}/finish`, { result: 'done' });
    expect(bad.status).toBe(422);
    const finish = await sendAsRunner(runner, 'POST', `${base}/finish`, { result: 'finished', summary: `used ${secret}`, acted: true });
    expect(finish.status).toBe(200);
    expect((await finish.json()) as JobDto).toMatchObject({ state: 'finished', result: { summary: 'used [redacted:job-token]', acted: true } });

    expect((await sendAsRunner(runner, 'POST', `${base}/heartbeat`, {})).status).toBe(409);
    const dead = await sendAsJob(runner, jobToken, 'GET', `/api/v1/projects/${project.slug}/items`);
    expect(dead.status).toBe(401);
    // Run now may be repeated once the first job is done.
    expect((await send('POST', `/api/v1/projects/${project.slug}/jobs`, { kind: 'slot-dev' })).status).toBe(201);
  });

  it('requeues a lapsed lease once with a fresh token, then loses the job and counts the streak', async () => {
    const project = await seedTrackerProject();
    const runner = await runnerFor([project.slug]);
    await enqueueJob(project.slug);
    const first = (await claim(runner)) as ClaimResponse;
    await env.DB.prepare(`UPDATE jobs SET lease_until = '2026-01-01T00:00:00.000Z' WHERE id = ?1`).bind(first.job.id).run();

    const second = (await claim(runner)) as ClaimResponse;
    expect(second.job).toMatchObject({ id: first.job.id, attempt: 2, state: 'claimed' });
    expect(second.jobToken).not.toBe(first.jobToken);
    expect((await sendAsJob(runner, first.jobToken, 'GET', `/api/v1/projects/${project.slug}/items`)).status).toBe(401);

    await env.DB.prepare(`UPDATE jobs SET lease_until = '2026-01-01T00:00:00.000Z' WHERE id = ?1`).bind(first.job.id).run();
    expect(await claim(runner)).toBeNull();
    const lost = (await (await send('GET', `/api/v1/projects/${project.slug}/jobs/${first.job.id}`)).json()) as JobDto;
    expect(lost).toMatchObject({ state: 'lost', result: { reason: 'lost' } });
    const streak = await env.DB.prepare(`SELECT failed_streak FROM team_state WHERE project_slug = ?1`).bind(project.slug).first<{ failed_streak: number }>();
    expect(streak?.failed_streak).toBe(1);
  });

  it('pauses the project after three failures in a row, and resume clears the streak', async () => {
    const project = await seedTrackerProject();
    const runner = await runnerFor([project.slug]);
    for (let round = 0; round < 3; round += 1) {
      await enqueueJob(project.slug);
      const { job } = (await claim(runner)) as ClaimResponse;
      const finish = await sendAsRunner(runner, 'POST', `/api/v1/runner/jobs/${job.id}/finish`, { result: 'failed', summary: 'boom' });
      expect(finish.status).toBe(200);
    }
    await enqueueJob(project.slug);
    expect(await claim(runner)).toBeNull();
    const state = await env.DB.prepare(`SELECT paused_by, failed_streak FROM team_state WHERE project_slug = ?1`).bind(project.slug).first<{ paused_by: string; failed_streak: number }>();
    expect(state).toEqual({ paused_by: 'system:failure-streak', failed_streak: 3 });
    const audit = await env.DB.prepare(`SELECT actor_kind, actor, details FROM audit_events WHERE kind = 'team.paused' AND target = ?1`)
      .bind(project.slug)
      .first<{ actor_kind: string; actor: string; details: string }>();
    expect(audit).toMatchObject({ actor_kind: 'system', actor: 'failure-streak' });
    expect(JSON.parse(audit?.details ?? '{}')).toMatchObject({ reason: 'failure-streak' });
    expect((await send('POST', `/api/v1/projects/${project.slug}/team/resume`, {})).status).toBe(201);
    expect((await claim(runner))?.job.projectSlug).toBe(project.slug);
  });

  it('refuses malformed events and finish bodies with 422, and a done job with 409 job-finished (#490 review)', async () => {
    const project = await seedTrackerProject();
    const runner = await runnerFor([project.slug]);
    await enqueueJob(project.slug);
    const { job } = (await claim(runner)) as ClaimResponse;
    const base = `/api/v1/runner/jobs/${job.id}`;
    const badEvents = await sendAsRunner(runner, 'POST', `${base}/events`, { events: [{ level: 'loud', kind: 'log', payload: {} }] });
    expect(badEvents.status).toBe(422);
    expect(await slugOf(badEvents)).toBe('job-events-invalid');
    expect(((await badEvents.json()) as { field: string }).field).toBe('events[0].level');
    const badFinish = await sendAsRunner(runner, 'POST', `${base}/finish`, { result: 'finished', summary: 1 });
    expect(badFinish.status).toBe(422);
    expect(await slugOf(badFinish)).toBe('job-finish-invalid');
    expect((await sendAsRunner(runner, 'POST', `${base}/finish`, { result: 'finished', summary: 'ok' })).status).toBe(200);
    for (const [path, body] of [
      ['events', { events: [{ level: 'info', kind: 'log', payload: {} }] }],
      ['finish', { result: 'failed', summary: 'again' }],
    ] as const) {
      const response = await sendAsRunner(runner, 'POST', `${base}/${path}`, body);
      expect(response.status).toBe(409);
      expect(await slugOf(response)).toBe('job-finished');
    }
  });

  it('cancels the live job of a project the runner’s allow-list loses, and closes its door at once (#490 review)', async () => {
    const kept = await seedTrackerProject();
    const lost = await seedTrackerProject();
    const runner = await runnerFor([kept.slug, lost.slug]);
    await enqueueJob(lost.slug);
    const { jobToken, job } = (await claim(runner)) as ClaimResponse;
    const narrowed = await send('PATCH', `/api/v1/accounts/${OWNER_ACCOUNT_ID}/runners/${runner.id}`, { allowedProjects: [kept.slug] });
    expect(narrowed.status).toBe(200);
    const after = (await (await send('GET', `/api/v1/projects/${lost.slug}/jobs/${job.id}`)).json()) as JobDto;
    expect(after).toMatchObject({ state: 'cancelled', result: { reason: 'runner-allow-list' } });
    expect((await sendAsJob(runner, jobToken, 'GET', `/api/v1/projects/${lost.slug}/items`)).status).toBe(401);
    expect((await sendAsRunner(runner, 'POST', `/api/v1/runner/jobs/${job.id}/heartbeat`, {})).status).toBe(404);
  });

  it('never extends a lease past started_at + maxMinutes (#490 review)', async () => {
    const project = await seedTrackerProject();
    const runner = await runnerFor([project.slug]);
    await enqueueJob(project.slug, { maxMinutes: 2 });
    const { job } = (await claim(runner)) as ClaimResponse;
    const base = `/api/v1/runner/jobs/${job.id}`;
    const beat = await sendAsRunner(runner, 'POST', `${base}/heartbeat`, {});
    expect(beat.status).toBe(200);
    const { leaseUntil } = (await beat.json()) as { leaseUntil: string };
    expect(Date.parse(leaseUntil) - Date.parse(job.claimedAt ?? '')).toBeLessThanOrEqual(2 * 60 * 1000);
    await env.DB.prepare(`UPDATE jobs SET started_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1`).bind(job.id).run();
    const late = await sendAsRunner(runner, 'POST', `${base}/heartbeat`, {});
    expect(late.status).toBe(409);
    expect(await slugOf(late)).toBe('job-lease-expired');
  });

  it('judges X-Runner-Jwt on a job call as the runner door does: a future iat is refused (#489 review)', async () => {
    const project = await seedTrackerProject();
    const runner = await runnerFor([project.slug]);
    await enqueueJob(project.slug);
    const { jobToken } = (await claim(runner)) as ClaimResponse;
    const response = await sendAsJob(runner, jobToken, 'GET', `/api/v1/projects/${project.slug}/items`, undefined, {
      jwt: { issuedAt: Math.floor(Date.now() / 1000) + 3600, lifetimeSeconds: 300 },
    });
    expect(response.status).toBe(401);
    expect(await slugOf(response)).toBe('runner-jwt-invalid');
  });

  it('cancels a revoked runner’s live job and its token', async () => {
    const project = await seedTrackerProject();
    const runner = await runnerFor([project.slug]);
    await enqueueJob(project.slug);
    const { jobToken, job } = (await claim(runner)) as ClaimResponse;
    const revoke = await send('POST', `/api/v1/accounts/${OWNER_ACCOUNT_ID}/runners/${runner.id}/revoke`, {});
    expect(revoke.status).toBe(200);
    const after = (await (await send('GET', `/api/v1/projects/${project.slug}/jobs/${job.id}`)).json()) as JobDto;
    expect(after).toMatchObject({ state: 'cancelled', result: { reason: 'runner-revoked' } });
    expect((await sendAsJob(runner, jobToken, 'GET', `/api/v1/projects/${project.slug}/items`)).status).toBe(401);
  });

  it('never lets a job token, as a bearer or in a body, reach a log line', async () => {
    const project = await seedTrackerProject();
    const runner = await runnerFor([project.slug]);
    await enqueueJob(project.slug);
    const lines: string[] = [];
    const response = await sendAsRunner(runner, 'POST', CLAIM, {}, { logSink: (line) => lines.push(line) });
    const { jobToken } = (await response.json()) as ClaimResponse;
    await sendAsJob(runner, jobToken, 'GET', `/api/v1/projects/${project.slug}/items`, undefined, { logSink: (line) => lines.push(line) });
    await sendAsJob(runner, `${jobToken}x`, 'GET', `/api/v1/projects/${project.slug}/items`, undefined, { logSink: (line) => lines.push(line) });
    const log = lines.join('\n');
    expect(log).not.toContain(jobToken.slice(4, 24));
    expect(log).toContain('job-token-invalid');
  });

  it('is the owner’s to list and a member’s to read; another account sees nothing', async () => {
    const other = await seedSessionUser('owner');
    const project = await seedTrackerProject();
    const jobId = await enqueueJob(project.slug);
    const list = await send('GET', `/api/v1/projects/${project.slug}/jobs?state=queued`);
    expect(((await list.json()) as { jobs: JobDto[] }).jobs.map((job) => job.id)).toEqual([jobId]);
    const foreign = await sendAsSession(other, 'GET', `/api/v1/projects/${project.slug}/jobs/${jobId}`);
    expect(foreign.status).toBe(404);
    expect((await send('GET', `/api/v1/projects/${project.slug}/jobs/01M6YSNJ0000000000000NOPE1`)).status).toBe(404);
  });
});
