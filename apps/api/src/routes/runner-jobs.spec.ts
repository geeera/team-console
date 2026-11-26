import { env } from 'cloudflare:test';
import { OWNER_ACCOUNT_ID, type ClaimResponse, type JobDto, type JobEventListDto } from '@shared/contracts';
import { JOB_TOKEN_PREFIX } from '@shared/redaction';
import { IdempotencyKeysRepo } from '@worker/db';
import { localEnv } from '../testing/github-kit';
import {
  cancelJob,
  cancelJobsInFlight,
  commitDuringAuthentication,
  enqueueJob,
  enrolRunner,
  narrowRunner,
  revokeRunner,
  sendAsJob,
  sendAsRunner,
  setProjectAccessSource,
  type TestRunner,
} from '../testing/runner-kit';
import type { RunnerSelfDto } from '@shared/contracts';
import {
  seedAccountProject,
  seedMembership,
  seedSessionUser,
  seedUser,
  sendAsSession,
} from '../testing/session-kit';
import { countRows, seedItem, seedTrackerProject, send, slugOf } from '../testing/tracker-kit';

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

// More claims than the owner's entitled concurrency admits at once (#746) pile up across these cases.
beforeEach(cancelJobsInFlight);

describe('POST /api/v1/runner/jobs/claim', () => {
  it('answers 204 with Retry-After while nothing is queued, then hands out one job with a tcj_ token and a lease', async () => {
    const project = await seedTrackerProject();
    const runner = await runnerFor([project.slug]);
    expect(await claim(runner)).toBeNull();

    const jobId = await enqueueJob(project.slug, { items: [3, 1] });
    const claimed = await claim(runner);
    expect(claimed?.job).toMatchObject({
      id: jobId,
      state: 'claimed',
      runnerId: runner.id,
      attempt: 1,
      role: 'orchestrator',
      items: [3, 1],
    });
    expect(claimed?.jobToken.startsWith(JOB_TOKEN_PREFIX)).toBe(true);
    expect(claimed?.leaseSeconds).toBe(300);
    // One job, once: the next poll finds nothing, and the token is stored hashed only.
    expect(await claim(runner)).toBeNull();
    const row = await env.DB.prepare(`SELECT token_hash FROM jobs WHERE id = ?1`)
      .bind(jobId)
      .first<{ token_hash: string }>();
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.token_hash).not.toContain(claimed?.jobToken.slice(4, 20));
    const audit = await env.DB.prepare(
      `SELECT actor_kind, actor FROM audit_events WHERE kind = 'job.claimed' AND target = ?1`,
    )
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
    const row = await env.DB.prepare(`SELECT state, runner_id FROM jobs WHERE id = ?1`)
      .bind(theirJob)
      .first<{ state: string; runner_id: null }>();
    expect(row).toEqual({ state: 'queued', runner_id: null });
  });

  // #775, R-SCOPE-3: an `all` runner of account A sees, claims and writes nothing of account B; a project created in A
  // after its enrolment is claimed; the claim carries the scope the runner holds itself to.
  it('an all-scope runner claims any project of its account, one created later included, and nothing of another account', async () => {
    const other = await seedSessionUser('owner');
    const theirs = await seedAccountProject(other.account, { tracker: 'console' });
    const theirJob = await enqueueJob(theirs.slug, {}, other);
    const runner = await enrolRunner(OWNER_ACCOUNT_ID, { projectScope: 'all' });
    expect(runner.enrolment).toMatchObject({ projectScope: 'all', allowedProjects: [] });
    expect(await claim(runner)).toBeNull();

    const project = await seedTrackerProject();
    const jobId = await enqueueJob(project.slug);
    const claimed = await claim(runner);
    expect(claimed?.job.id).toBe(jobId);
    expect(claimed?.scope).toMatchObject({ projectScope: 'all', allowedProjects: [] });
    expect(claimed?.scope.projects).toContain(project.slug);
    expect(claimed?.scope.projects).not.toContain(theirs.slug);
    // Its job token writes nothing in B, and `/runner/self` lists nothing of B.
    const foreign = await sendAsJob(
      runner,
      claimed?.jobToken ?? '',
      'POST',
      `/api/v1/projects/${theirs.slug}/items`,
      { title: 'x', kind: 'task' },
    );
    expect(foreign.status).toBe(404);
    const self = await sendAsRunner(runner, 'GET', '/api/v1/runner/self');
    expect(self.status).toBe(200);
    const text = await self.text();
    const body = JSON.parse(text) as RunnerSelfDto;
    expect(body.runner).toMatchObject({
      id: runner.id,
      accountId: OWNER_ACCOUNT_ID,
      projectScope: 'all',
      allowedProjects: [],
    });
    expect(body.projects.map((row) => row.slug)).toContain(project.slug);
    expect(text).not.toContain(theirs.slug);
    expect(text).not.toContain(other.account.id);
    const row = await env.DB.prepare(`SELECT state, runner_id FROM jobs WHERE id = ?1`)
      .bind(theirJob)
      .first<{ state: string; runner_id: null }>();
    expect(row).toEqual({ state: 'queued', runner_id: null });
  });

  // #775 (SECURITY question 7): the claim body's declaration is stored and narrows the claim to the declared sources.
  it('stores the accessSources a claim declares and claims nothing on a source outside them', async () => {
    const project = await seedTrackerProject();
    await setProjectAccessSource(project.slug, 'api_key');
    const runner = await runnerFor([project.slug]);
    await enqueueJob(project.slug);
    const declared = await sendAsRunner(runner, 'POST', CLAIM, { accessSources: ['subscription'] });
    expect(declared.status).toBe(204);
    const stored = await env.DB.prepare(`SELECT capabilities FROM runners WHERE id = ?1`)
      .bind(runner.id)
      .first<{ capabilities: string }>();
    expect(JSON.parse(stored?.capabilities ?? '{}')).toMatchObject({ accessSources: ['subscription'] });
    const widened = await sendAsRunner(runner, 'POST', CLAIM, { accessSources: ['api_key'] });
    expect(widened.status).toBe(200);
    const junk = await sendAsRunner(runner, 'POST', CLAIM, { accessSources: ['everything'] });
    expect(junk.status).toBe(422);
    expect(((await junk.json()) as { field: string }).field).toBe('accessSources');
    const extra = await sendAsRunner(runner, 'POST', CLAIM, { accessSources: ['api_key'], hosted: 1 });
    expect(extra.status).toBe(422);
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
      const pin = await send('PUT', `/api/v1/projects/${project.slug}/runner-policy`, {
        mode: 'pinned',
        runner: mac.id,
      });
      expect(pin.status).toBe(200);
      expect(await claim(vps)).toBeNull();
      const repin = await send('PUT', `/api/v1/projects/${project.slug}/runner-policy`, {
        mode: 'pinned',
        runner: vps.id,
      });
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
      await env.DB.prepare(`UPDATE runners SET last_seen_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1`)
        .bind(mac.id)
        .run();
      expect((await claim(vps))?.job.runnerId).toBe(vps.id);
    });

    it('the account default applies where a project has none, and a policy naming a foreign runner is refused', async () => {
      const project = await seedTrackerProject();
      const mac = await runnerFor([project.slug]);
      const vps = await runnerFor([project.slug]);
      const other = await seedSessionUser('owner');
      const foreign = await enrolRunner(other.account.id, { as: other });
      await enqueueJob(project.slug);
      const bad = await send('PUT', `/api/v1/accounts/${OWNER_ACCOUNT_ID}/runner-policy`, {
        mode: 'pinned',
        runner: foreign.id,
      });
      expect(bad.status).toBe(422);
      expect(await slugOf(bad)).toBe('runner-policy-invalid');
      const badProject = await send('PUT', `/api/v1/projects/${project.slug}/runner-policy`, {
        mode: 'pinned',
        runner: foreign.id,
      });
      expect(badProject.status).toBe(422);
      expect(
        (
          await send('PUT', `/api/v1/accounts/${OWNER_ACCOUNT_ID}/runner-policy`, {
            mode: 'pinned',
            runner: mac.id,
          })
        ).status,
      ).toBe(200);
      expect(await claim(vps)).toBeNull();
      expect((await claim(mac))?.job.runnerId).toBe(mac.id);
      await send('PUT', `/api/v1/accounts/${OWNER_ACCOUNT_ID}/runner-policy`, { mode: 'any' });
      const audit = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'runner.policy-changed'`,
      ).first<{ n: number }>();
      expect(audit?.n).toBeGreaterThanOrEqual(2);
    });
  });

  it('skips a job of a suspended account and of an archived project (#490 review)', async () => {
    const other = await seedSessionUser('owner');
    const theirs = await seedAccountProject(other.account, { tracker: 'console' });
    await enqueueJob(theirs.slug, {}, other);
    const theirRunner = await enrolRunner(other.account.id, { as: other, allowedProjects: [theirs.slug] });
    await env.DB.prepare(`UPDATE accounts SET suspended_at = '2026-11-10T00:00:00.000Z' WHERE id = ?1`)
      .bind(other.account.id)
      .run();
    expect(await claim(theirRunner)).toBeNull();

    const project = await seedTrackerProject();
    const runner = await runnerFor([project.slug]);
    await enqueueJob(project.slug);
    await env.DB.prepare(`UPDATE projects SET archived_at = '2026-11-10T00:00:00.000Z' WHERE slug = ?1`)
      .bind(project.slug)
      .run();
    expect(await claim(runner)).toBeNull();
  });

  it('refuses a none-isolation runner on production', async () => {
    const project = await seedTrackerProject();
    const runner = await runnerFor([project.slug], { isolation: 'none' });
    const response = await sendAsRunner(
      runner,
      'POST',
      CLAIM,
      {},
      {
        bindings: localEnv({ ENVIRONMENT: 'production', AUTH_MODE: undefined }),
        jwt: { audience: 'team-console:production' },
      },
    );
    expect(response.status).toBe(403);
    expect(await slugOf(response)).toBe('runner-isolation-none');
  });
});

describe('the account’s entitled concurrency at the claim (#746, ADR 0008 decision 6)', () => {
  /** A free-tier account of its own (a session owner's), with one console-tracker project and `runners` runners on it. */
  async function freeAccount(runners: number) {
    const owner = await seedSessionUser('owner');
    const project = await seedAccountProject(owner.account, { tracker: 'console' });
    const enrolled: TestRunner[] = [];
    for (let n = 0; n < runners; n += 1) {
      enrolled.push(await enrolRunner(owner.account.id, { as: owner, allowedProjects: [project.slug] }));
    }
    return { owner, slug: project.slug, runners: enrolled };
  }

  const setEntitlements = (accountId: string, json: string) =>
    env.DB.prepare(`UPDATE accounts SET entitlements = ?2 WHERE id = ?1`).bind(accountId, json).run();

  it('free tier, two runners: the second claim answers 204 with Retry-After until the first job ends', async () => {
    const {
      owner,
      slug,
      runners: [mac, vps],
    } = await freeAccount(2);
    if (mac === undefined || vps === undefined) {
      throw new Error('two runners were enrolled');
    }
    await enqueueJob(slug, { kind: 'review', role: 'qa' }, owner);
    const second = await enqueueJob(slug, { kind: 'review', role: 'security' }, owner);
    const first = await claim(mac);
    expect(first).not.toBeNull();
    // `claim` asserts the 204's Retry-After.
    expect(await claim(vps)).toBeNull();

    const finished = await sendAsRunner(mac, 'POST', `/api/v1/runner/jobs/${first?.job.id ?? ''}/finish`, {
      result: 'finished',
      summary: 'done',
    });
    expect(finished.status).toBe(200);
    expect((await claim(vps))?.job.id).toBe(second);
  });

  it('the operator’s override sets the limit: 2 admits two at once, 0 admits none', async () => {
    // Each runner runs one job at a time (its own `maxConcurrency` 1), so three runners can reach the account's limit.
    const { owner, slug, runners } = await freeAccount(3);
    for (const role of ['qa', 'security', 'reviewer']) {
      await enqueueJob(slug, { kind: 'review', role }, owner);
    }
    await setEntitlements(owner.account.id, '{"max_concurrency":2}');
    const claims = [];
    for (const runner of runners) {
      claims.push(await claim(runner));
    }
    expect(claims.map((claimed) => claimed !== null)).toEqual([true, true, false]);

    const stopped = await freeAccount(1);
    await setEntitlements(stopped.owner.account.id, '{"max_concurrency":0}');
    await enqueueJob(stopped.slug, {}, stopped.owner);
    const [only] = stopped.runners;
    expect(only === undefined ? null : await claim(only)).toBeNull();
  });

  it('two claims at once for the account’s last slot: one 200, one 204', async () => {
    const {
      owner,
      slug,
      runners: [mac, vps],
    } = await freeAccount(2);
    if (mac === undefined || vps === undefined) {
      throw new Error('two runners were enrolled');
    }
    await enqueueJob(slug, { kind: 'review', role: 'qa' }, owner);
    await enqueueJob(slug, { kind: 'review', role: 'security' }, owner);
    const statuses = await Promise.all(
      [mac, vps].map(async (runner) => (await sendAsRunner(runner, 'POST', CLAIM, {})).status),
    );
    expect(statuses.sort()).toEqual([200, 204]);
    const live = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM jobs WHERE project_slug = ?1 AND state = 'claimed'`,
    )
      .bind(slug)
      .first<{ n: number }>();
    expect(live?.n).toBe(1);
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

    const alone = await send('GET', `/api/v1/projects/${project.slug}/items`, undefined, {
      headers: { Authorization: `Bearer ${jobToken}` },
    });
    expect(alone.status).toBe(401);
    expect(await slugOf(alone)).toBe('job-runner-missing');

    const mismatch = await sendAsJob(impostor, jobToken, 'GET', `/api/v1/projects/${project.slug}/items`);
    expect(mismatch.status).toBe(403);
    expect(await slugOf(mismatch)).toBe('job-runner-mismatch');

    const unknown = await sendAsJob(
      runner,
      `${JOB_TOKEN_PREFIX}${'z'.repeat(43)}`,
      'GET',
      `/api/v1/projects/${project.slug}/items`,
    );
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
    const events = await sendAsRunner(
      runner,
      'POST',
      `${base}/events`,
      {
        events: [
          { level: 'info', kind: 'started', payload: { skill: 'slot-dev' } },
          { level: 'info', kind: 'log', payload: { line: `export TC_JOB_TOKEN=${secret}` } },
        ],
      },
      { logSink: (line) => lines.push(line) },
    );
    expect(events.status).toBe(201);
    expect(await events.json()).toEqual({ lastSeq: 3, capped: false });
    expect(lines.join('\n')).not.toContain(secret);

    const read = await send('GET', `/api/v1/projects/${project.slug}/jobs/${job.id}/events`);
    const { events: stored } = (await read.json()) as JobEventListDto;
    expect(stored.map((event) => event.kind)).toEqual(['notice', 'started', 'log']);
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(JSON.stringify(stored)).toContain('[redacted:job-token]');
    expect(
      ((await (await send('GET', `/api/v1/projects/${project.slug}/jobs/${job.id}`)).json()) as JobDto).state,
    ).toBe('running');

    const bad = await sendAsRunner(runner, 'POST', `${base}/finish`, { result: 'done' });
    expect(bad.status).toBe(422);
    const finish = await sendAsRunner(runner, 'POST', `${base}/finish`, {
      result: 'finished',
      summary: `used ${secret}`,
      acted: true,
    });
    expect(finish.status).toBe(200);
    expect((await finish.json()) as JobDto).toMatchObject({
      state: 'finished',
      result: { summary: 'used [redacted:job-token]', acted: true },
    });

    expect((await sendAsRunner(runner, 'POST', `${base}/heartbeat`, {})).status).toBe(409);
    const dead = await sendAsJob(runner, jobToken, 'GET', `/api/v1/projects/${project.slug}/items`);
    expect(dead.status).toBe(401);
    // Run now may be repeated once the first job is done.
    expect((await send('POST', `/api/v1/projects/${project.slug}/jobs`, { kind: 'slot-dev' })).status).toBe(
      201,
    );
  });

  it('requeues a lapsed lease once with a fresh token, then loses the job and counts the streak', async () => {
    const project = await seedTrackerProject();
    const runner = await runnerFor([project.slug]);
    await enqueueJob(project.slug);
    const first = (await claim(runner)) as ClaimResponse;
    await env.DB.prepare(`UPDATE jobs SET lease_until = '2026-01-01T00:00:00.000Z' WHERE id = ?1`)
      .bind(first.job.id)
      .run();

    const second = (await claim(runner)) as ClaimResponse;
    expect(second.job).toMatchObject({ id: first.job.id, attempt: 2, state: 'claimed' });
    expect(second.jobToken).not.toBe(first.jobToken);
    expect(
      (await sendAsJob(runner, first.jobToken, 'GET', `/api/v1/projects/${project.slug}/items`)).status,
    ).toBe(401);

    await env.DB.prepare(`UPDATE jobs SET lease_until = '2026-01-01T00:00:00.000Z' WHERE id = ?1`)
      .bind(first.job.id)
      .run();
    expect(await claim(runner)).toBeNull();
    const lost = (await (
      await send('GET', `/api/v1/projects/${project.slug}/jobs/${first.job.id}`)
    ).json()) as JobDto;
    expect(lost).toMatchObject({ state: 'lost', result: { reason: 'lost' } });
    const streak = await env.DB.prepare(`SELECT failed_streak FROM team_state WHERE project_slug = ?1`)
      .bind(project.slug)
      .first<{ failed_streak: number }>();
    expect(streak?.failed_streak).toBe(1);
  });

  it('pauses the project after three failures in a row, and resume clears the streak', async () => {
    const project = await seedTrackerProject();
    const runner = await runnerFor([project.slug]);
    for (let round = 0; round < 3; round += 1) {
      await enqueueJob(project.slug);
      const { job } = (await claim(runner)) as ClaimResponse;
      const finish = await sendAsRunner(runner, 'POST', `/api/v1/runner/jobs/${job.id}/finish`, {
        result: 'failed',
        summary: 'boom',
      });
      expect(finish.status).toBe(200);
    }
    await enqueueJob(project.slug);
    expect(await claim(runner)).toBeNull();
    const state = await env.DB.prepare(
      `SELECT paused_by, failed_streak FROM team_state WHERE project_slug = ?1`,
    )
      .bind(project.slug)
      .first<{ paused_by: string; failed_streak: number }>();
    expect(state).toEqual({ paused_by: 'system:failure-streak', failed_streak: 3 });
    const audit = await env.DB.prepare(
      `SELECT actor_kind, actor, details FROM audit_events WHERE kind = 'team.paused' AND target = ?1`,
    )
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
    const badEvents = await sendAsRunner(runner, 'POST', `${base}/events`, {
      events: [{ level: 'loud', kind: 'log', payload: {} }],
    });
    expect(badEvents.status).toBe(422);
    expect(await slugOf(badEvents)).toBe('job-events-invalid');
    expect(((await badEvents.json()) as { field: string }).field).toBe('events[0].level');
    const badFinish = await sendAsRunner(runner, 'POST', `${base}/finish`, {
      result: 'finished',
      summary: 1,
    });
    expect(badFinish.status).toBe(422);
    expect(await slugOf(badFinish)).toBe('job-finish-invalid');
    expect(
      (await sendAsRunner(runner, 'POST', `${base}/finish`, { result: 'finished', summary: 'ok' })).status,
    ).toBe(200);
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
    const narrowed = await send('PATCH', `/api/v1/accounts/${OWNER_ACCOUNT_ID}/runners/${runner.id}`, {
      projectScope: 'selected',
      allowedProjects: [kept.slug],
    });
    expect(narrowed.status).toBe(200);
    const after = (await (
      await send('GET', `/api/v1/projects/${lost.slug}/jobs/${job.id}`)
    ).json()) as JobDto;
    expect(after).toMatchObject({ state: 'cancelled', result: { reason: 'runner-allow-list' } });
    expect((await sendAsJob(runner, jobToken, 'GET', `/api/v1/projects/${lost.slug}/items`)).status).toBe(
      401,
    );
    expect((await sendAsRunner(runner, 'POST', `/api/v1/runner/jobs/${job.id}/heartbeat`, {})).status).toBe(
      404,
    );
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
    await env.DB.prepare(`UPDATE jobs SET started_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1`)
      .bind(job.id)
      .run();
    const late = await sendAsRunner(runner, 'POST', `${base}/heartbeat`, {});
    expect(late.status).toBe(409);
    expect(await slugOf(late)).toBe('job-lease-expired');
  });

  it('judges X-Runner-Jwt on a job call as the runner door does: a future iat is refused (#489 review)', async () => {
    const project = await seedTrackerProject();
    const runner = await runnerFor([project.slug]);
    await enqueueJob(project.slug);
    const { jobToken } = (await claim(runner)) as ClaimResponse;
    const response = await sendAsJob(
      runner,
      jobToken,
      'GET',
      `/api/v1/projects/${project.slug}/items`,
      undefined,
      {
        jwt: { issuedAt: Math.floor(Date.now() / 1000) + 3600, lifetimeSeconds: 300 },
      },
    );
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
    const after = (await (
      await send('GET', `/api/v1/projects/${project.slug}/jobs/${job.id}`)
    ).json()) as JobDto;
    expect(after).toMatchObject({ state: 'cancelled', result: { reason: 'runner-revoked' } });
    expect((await sendAsJob(runner, jobToken, 'GET', `/api/v1/projects/${project.slug}/items`)).status).toBe(
      401,
    );
  });

  it('never lets a job token, as a bearer or in a body, reach a log line', async () => {
    const project = await seedTrackerProject();
    const runner = await runnerFor([project.slug]);
    await enqueueJob(project.slug);
    const lines: string[] = [];
    const response = await sendAsRunner(runner, 'POST', CLAIM, {}, { logSink: (line) => lines.push(line) });
    const { jobToken } = (await response.json()) as ClaimResponse;
    await sendAsJob(runner, jobToken, 'GET', `/api/v1/projects/${project.slug}/items`, undefined, {
      logSink: (line) => lines.push(line),
    });
    await sendAsJob(runner, `${jobToken}x`, 'GET', `/api/v1/projects/${project.slug}/items`, undefined, {
      logSink: (line) => lines.push(line),
    });
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
    expect(
      (await send('GET', `/api/v1/projects/${project.slug}/jobs/01M6YSNJ0000000000000NOPE1`)).status,
    ).toBe(404);
  });
});

// #553: heartbeat, events and finish judge the runner's stored row inside the write, not only the copy read at
// authentication. A narrowing or revoke that commits in between (here: during the sighting, after the JWT checks)
// refuses the call and writes nothing; the cancel batch is left out to show the guard holds on its own.
describe('the stored allow-list and revoke on heartbeat, events and finish (#553)', () => {
  type Path = 'heartbeat' | 'events' | 'finish';
  const bodies: Record<Path, Record<string, unknown>> = {
    heartbeat: {},
    events: { events: [{ level: 'info', kind: 'started', payload: { n: 1 } }] },
    finish: { result: 'finished', summary: 's', acted: false },
  };
  const paths: readonly Path[] = ['heartbeat', 'events', 'finish'];

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function claimedJob(): Promise<{ runner: TestRunner; jobId: string; kept: string; lost: string }> {
    const kept = await seedTrackerProject();
    const lost = await seedTrackerProject();
    const runner = await runnerFor([kept.slug, lost.slug]);
    await enqueueJob(lost.slug);
    const { job } = (await claim(runner)) as ClaimResponse;
    return { runner, jobId: job.id, kept: kept.slug, lost: lost.slug };
  }

  async function expectUntouched(jobId: string, leaseUntil: string | null): Promise<void> {
    const row = await env.DB.prepare(`SELECT state, lease_until AS leaseUntil FROM jobs WHERE id = ?1`)
      .bind(jobId)
      .first<{ state: string; leaseUntil: string | null }>();
    expect(row).toEqual({ state: 'claimed', leaseUntil });
    const events = await env.DB.prepare(`SELECT COUNT(*) AS n FROM job_events WHERE job_id = ?1`)
      .bind(jobId)
      .first<{ n: number }>();
    expect(events?.n).toBe(1);
  }

  async function leaseOf(jobId: string): Promise<string | null> {
    return (
      (
        await env.DB.prepare(`SELECT lease_until AS l FROM jobs WHERE id = ?1`)
          .bind(jobId)
          .first<{ l: string | null }>()
      )?.l ?? null
    );
  }

  it.each(paths)(
    '%s: refuses with 404 once the project is gone from the stored list before the call',
    async (path) => {
      const { runner, jobId, kept } = await claimedJob();
      const lease = await leaseOf(jobId);
      await narrowRunner(runner.id, [kept])();
      const response = await sendAsRunner(
        runner,
        'POST',
        `/api/v1/runner/jobs/${jobId}/${path}`,
        bodies[path],
      );
      expect(response.status).toBe(404);
      expect(await slugOf(response)).toBe('job-not-found');
      await expectUntouched(jobId, lease);
    },
  );

  it.each(paths)(
    '%s: refuses with 404 when a narrowing commits between authentication and the write',
    async (path) => {
      const { runner, jobId, kept } = await claimedJob();
      const lease = await leaseOf(jobId);
      commitDuringAuthentication(narrowRunner(runner.id, [kept]));
      const response = await sendAsRunner(
        runner,
        'POST',
        `/api/v1/runner/jobs/${jobId}/${path}`,
        bodies[path],
      );
      expect(response.status).toBe(404);
      expect(await slugOf(response)).toBe('job-not-found');
      await expectUntouched(jobId, lease);
    },
  );

  it.each(paths)('%s: a revoked runner gets 401 runner-revoked, as on the claim', async (path) => {
    const { runner, jobId } = await claimedJob();
    const lease = await leaseOf(jobId);
    await revokeRunner(runner.id)();
    const response = await sendAsRunner(runner, 'POST', `/api/v1/runner/jobs/${jobId}/${path}`, bodies[path]);
    expect(response.status).toBe(401);
    expect(await slugOf(response)).toBe('runner-revoked');
    const claimed = await sendAsRunner(runner, 'POST', CLAIM, {});
    expect(claimed.status).toBe(401);
    expect(await slugOf(claimed)).toBe('runner-revoked');
    await expectUntouched(jobId, lease);
  });

  it.each(paths)(
    '%s: refuses with 401 runner-revoked when a revoke commits between authentication and the write',
    async (path) => {
      const { runner, jobId } = await claimedJob();
      const lease = await leaseOf(jobId);
      commitDuringAuthentication(revokeRunner(runner.id));
      const response = await sendAsRunner(
        runner,
        'POST',
        `/api/v1/runner/jobs/${jobId}/${path}`,
        bodies[path],
      );
      expect(response.status).toBe(401);
      expect(await slugOf(response)).toBe('runner-revoked');
      await expectUntouched(jobId, lease);
    },
  );

  it.each(paths)('%s: still succeeds while the stored list keeps the project', async (path) => {
    const { runner, jobId, lost } = await claimedJob();
    commitDuringAuthentication(narrowRunner(runner.id, [lost]));
    const response = await sendAsRunner(runner, 'POST', `/api/v1/runner/jobs/${jobId}/${path}`, bodies[path]);
    expect(response.status).toBe(path === 'events' ? 201 : 200);
  });
});

// #580: a tracker write under a job token judges the job inside its own batch (the key's completion carries the
// guard), not only the copy authentication read. A narrowing, revoke or cleared token that commits in between (here:
// during the sighting, the last step of `jobIdentityOf`) refuses the write and leaves nothing behind.
describe('tracker writes under a job token judge the stored runner and job inside the write (#580)', () => {
  type Write = 'comment' | 'item';
  const writes: readonly Write[] = ['comment', 'item'];

  interface HeldJob {
    readonly runner: TestRunner;
    readonly jobId: string;
    readonly jobToken: string;
    readonly kept: string;
    readonly lost: string;
    readonly itemPath: string;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function heldJob(): Promise<HeldJob> {
    const kept = await seedTrackerProject();
    const lost = await seedTrackerProject();
    const { path } = await seedItem(lost);
    const runner = await runnerFor([kept.slug, lost.slug]);
    await enqueueJob(lost.slug);
    const { job, jobToken } = (await claim(runner)) as ClaimResponse;
    return { runner, jobId: job.id, jobToken, kept: kept.slug, lost: lost.slug, itemPath: path };
  }

  function writeAsJob(held: HeldJob, write: Write): Promise<Response> {
    return write === 'comment'
      ? sendAsJob(held.runner, held.jobToken, 'POST', `${held.itemPath}/comments`, { body: 'Picked up' })
      : sendAsJob(held.runner, held.jobToken, 'POST', `/api/v1/projects/${held.lost}/items`, {
          title: 'Follow-up',
          kind: 'chore',
        });
  }

  async function writtenRows(
    slug: string,
  ): Promise<{ items: number; comments: number; events: number; completedKeys: number }> {
    const completedKeys = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM idempotency_keys WHERE status IS NOT NULL',
    ).first<{ n: number }>();
    return {
      items: await countRows('items', slug),
      comments: await countRows('comments', slug),
      events: await countRows('item_events', slug),
      completedKeys: completedKeys?.n ?? 0,
    };
  }

  it.each(writes)(
    '%s: refuses with 403 job-runner-mismatch when a narrowing commits between authentication and the write',
    async (write) => {
      const held = await heldJob();
      const before = await writtenRows(held.lost);
      commitDuringAuthentication(narrowRunner(held.runner.id, [held.kept]));
      const response = await writeAsJob(held, write);
      expect(response.status).toBe(403);
      expect(await slugOf(response)).toBe('job-runner-mismatch');
      expect(await writtenRows(held.lost)).toEqual(before);
    },
  );

  it.each(writes)(
    '%s: refuses with 401 runner-revoked when a revoke commits between authentication and the write',
    async (write) => {
      const held = await heldJob();
      const before = await writtenRows(held.lost);
      commitDuringAuthentication(revokeRunner(held.runner.id));
      const response = await writeAsJob(held, write);
      expect(response.status).toBe(401);
      expect(await slugOf(response)).toBe('runner-revoked');
      expect(await writtenRows(held.lost)).toEqual(before);
    },
  );

  it.each(writes)(
    '%s: refuses with 401 job-token-invalid when a cancel commits between authentication and the write',
    async (write) => {
      const held = await heldJob();
      const before = await writtenRows(held.lost);
      commitDuringAuthentication(cancelJob(held.jobId));
      const response = await writeAsJob(held, write);
      expect(response.status).toBe(401);
      expect(await slugOf(response)).toBe('job-token-invalid');
      expect(await writtenRows(held.lost)).toEqual(before);
    },
  );

  it.each(writes)('%s: still writes while the stored list keeps the project', async (write) => {
    const held = await heldJob();
    const before = await writtenRows(held.lost);
    commitDuringAuthentication(narrowRunner(held.runner.id, [held.lost]));
    const response = await writeAsJob(held, write);
    expect(response.status).toBe(201);
    const after = await writtenRows(held.lost);
    expect(after.completedKeys).toBe(before.completedKeys + 1);
    expect(after.events).toBeGreaterThan(before.events);
  });

  /**
   * #678: once this request has claimed its key, a same-request retry takes the claim over (its 30 s hold ran out)
   * and completes or releases it, then `change` commits; this request's completion then matches no pending row.
   */
  function takeOverAfterClaim(retry: 'completes' | 'releases', change: () => Promise<unknown>): void {
    const claimKey = IdempotencyKeysRepo.prototype.claim;
    vi.spyOn(IdempotencyKeysRepo.prototype, 'claim').mockImplementationOnce(async function (
      this: IdempotencyKeysRepo,
      key,
      hash,
      nowMs,
      holdMs,
    ) {
      const first = await claimKey.call(this, key, hash, nowMs, holdMs);
      expect(await claimKey.call(this, key, hash, nowMs + holdMs, holdMs)).toEqual({ state: 'claimed' });
      if (retry === 'completes') {
        await this.completeStatement(
          key,
          hash,
          { status: 201, kind: 'item', ref: { value: '1' } },
          nowMs + 86_400_000,
        ).run();
      } else {
        await this.release(key, hash);
      }
      await change();
      return first;
    });
  }

  it.each(['completes', 'releases'] as const)(
    'refuses with 403 job-runner-mismatch when a retry %s the key and a narrowing commits before the write',
    async (retry) => {
      const held = await heldJob();
      const before = await writtenRows(held.lost);
      takeOverAfterClaim(retry, narrowRunner(held.runner.id, [held.kept]));
      const response = await writeAsJob(held, 'comment');
      expect(response.status).toBe(403);
      expect(await slugOf(response)).toBe('job-runner-mismatch');
      const after = await writtenRows(held.lost);
      expect({ ...after, completedKeys: before.completedKeys }).toEqual(before);
      expect(after.completedKeys).toBe(before.completedKeys + (retry === 'completes' ? 1 : 0));
    },
  );

  it('still writes, and completes the key, when a retry released it while the job holds', async () => {
    const held = await heldJob();
    const before = await writtenRows(held.lost);
    takeOverAfterClaim('releases', () => Promise.resolve());
    const response = await writeAsJob(held, 'comment');
    expect(response.status).toBe(201);
    const after = await writtenRows(held.lost);
    expect(after.comments).toBe(before.comments + 1);
    expect(after.completedKeys).toBe(before.completedKeys + 1);
  });
});

// #794: the routes judge a job's runner scope by the claim's own SQL term, owner decision D3 included — a subscription
// runner under `all` in an account with more than one owner serves only the projects its enrolling owner created.
describe('the job token under owner decision D3 (#794)', () => {
  const setCreator = (slug: string, by: string) =>
    env.DB.prepare(`UPDATE projects SET created_by = ?2 WHERE slug = ?1`).bind(slug, by).run();
  const readAsJob = (runner: TestRunner, jobToken: string, slug: string, jobId: string) =>
    sendAsJob(runner, jobToken, 'GET', `/api/v1/projects/${slug}/jobs/${jobId}`);

  /** A two-owner account, a project the second owner created, and a live job on it claimed by the first owner's runner. */
  async function otherOwnersJob() {
    const owner = await seedSessionUser('owner');
    const second = await seedUser('owner');
    await seedMembership(owner.account.id, second, 'owner');
    const theirs = await seedAccountProject(owner.account, { tracker: 'console' });
    await setCreator(theirs.slug, second);
    const runner = await enrolRunner(owner.account.id, {
      as: owner,
      projectScope: 'selected',
      allowedProjects: [theirs.slug],
    });
    const jobId = await enqueueJob(theirs.slug, {}, owner);
    const claimed = await claim(runner);
    expect(claimed?.job.id).toBe(jobId);
    const ok = await readAsJob(runner, claimed?.jobToken ?? '', theirs.slug, jobId);
    expect(ok.status).toBe(200);
    return { owner, slug: theirs.slug, runner, jobId, jobToken: claimed?.jobToken ?? '' };
  }

  it('refuses a live job’s token once its runner’s stored scope goes from selected to all and D3 drops the project', async () => {
    const held = await otherOwnersJob();
    // The row alone, as a write that commits past any cancel batch would leave it: the token is still stored.
    await env.DB.prepare(`UPDATE runners SET project_scope = 'all', allowed_projects = '[]' WHERE id = ?1`)
      .bind(held.runner.id)
      .run();

    const read = await readAsJob(held.runner, held.jobToken, held.slug, held.jobId);
    expect(read.status).toBe(403);
    expect(await slugOf(read)).toBe('job-runner-mismatch');
    const heartbeat = await sendAsRunner(
      held.runner,
      'POST',
      `/api/v1/runner/jobs/${held.jobId}/heartbeat`,
      {},
    );
    expect(heartbeat.status).toBe(404);
    expect(await slugOf(heartbeat)).toBe('job-not-found');
  });

  it('cancels the job a selected→all change drops under D3, in the change’s own batch', async () => {
    const held = await otherOwnersJob();
    const patched = await sendAsSession(
      held.owner,
      'PATCH',
      `/api/v1/accounts/${held.owner.account.id}/runners/${held.runner.id}`,
      {
        projectScope: 'all',
        allowedProjects: [],
      },
    );
    expect(patched.status).toBe(200);
    expect(
      await env.DB.prepare(`SELECT state, token_hash, result FROM jobs WHERE id = ?1`)
        .bind(held.jobId)
        .first(),
    ).toEqual({
      state: 'cancelled',
      token_hash: null,
      result: '{"reason":"runner-allow-list"}',
    });
    const read = await readAsJob(held.runner, held.jobToken, held.slug, held.jobId);
    expect(read.status).toBe(401);
    expect(await slugOf(read)).toBe('job-token-invalid');
  });

  it('refuses a live job’s token once a second owner joins and D3 drops a project the enroller did not create', async () => {
    const owner = await seedSessionUser('owner');
    const member = await seedUser('member');
    await seedMembership(owner.account.id, member, 'member');
    const project = await seedAccountProject(owner.account, { tracker: 'console' });
    await setCreator(project.slug, member);
    const runner = await enrolRunner(owner.account.id, { as: owner, projectScope: 'all' });
    const jobId = await enqueueJob(project.slug, {}, owner);
    const claimed = await claim(runner);
    expect(claimed?.job.id).toBe(jobId);
    const jobToken = claimed?.jobToken ?? '';
    expect((await readAsJob(runner, jobToken, project.slug, jobId)).status).toBe(200);

    await seedMembership(owner.account.id, await seedUser('owner'), 'owner');

    const read = await readAsJob(runner, jobToken, project.slug, jobId);
    expect(read.status).toBe(403);
    expect(await slugOf(read)).toBe('job-runner-mismatch');
    const events = await sendAsRunner(runner, 'POST', `/api/v1/runner/jobs/${jobId}/events`, {
      events: [{ level: 'info', kind: 'log', payload: {} }],
    });
    expect(events.status).toBe(404);
  });
});
