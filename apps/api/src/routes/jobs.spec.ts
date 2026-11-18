import { env } from 'cloudflare:test';
import { JOB_KINDS, OWNER_ACCOUNT_ID, isJobKindBeforeCutover, type JobDto, type JobListDto, type RunnerPolicyDto } from '@shared/contracts';
import { seedAccount, seedAccountProject, seedMembership, seedSession, seedSessionUser, seedUser, sendAsSession } from '../testing/session-kit';
import { jobActor, seedGitHubProject, seedTrackerProject, send, sendAsService, slugOf } from '../testing/tracker-kit';
import { localEnv } from '../testing/github-kit';

// #467: Run now and the queue reads behind the route matrix (ADR 0006 "API and authorisation": `POST …/jobs` owner).

describe('POST /api/v1/projects/:slug/jobs (Run now)', () => {
  it('enqueues a queued job with the audit row, and refuses a second live one with 409 job-exists', async () => {
    const project = await seedTrackerProject();
    const first = await send('POST', `/api/v1/projects/${project.slug}/jobs`, { kind: 'slot-pm', items: [2] });
    expect(first.status).toBe(201);
    expect((await first.json()) as JobDto).toMatchObject({ state: 'queued', kind: 'slot-pm', role: 'orchestrator', items: [2], requestedBy: 'owner', dispatch: 'pull' });
    const again = await send('POST', `/api/v1/projects/${project.slug}/jobs`, { kind: 'slot-pm' });
    expect(again.status).toBe(409);
    expect(await slugOf(again)).toBe('job-exists');
    const audit = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'job.dispatched' AND account_id = ?1`).bind(OWNER_ACCOUNT_ID).first<{ n: number }>();
    expect(audit?.n).toBeGreaterThanOrEqual(1);
  });

  // #775 (SECURITY Q8): one GitHub project per kind, so a slot's dedupe key never answers for another kind.
  it.each(JOB_KINDS.map((kind) => [kind, isJobKindBeforeCutover(kind)] as const))(
    'on a project still on GitHub Issues, %s is enqueued only when the allow-list names it (%s)',
    async (kind, isAllowed) => {
      const github = await seedGitHubProject();
      const response = await send('POST', `/api/v1/projects/${github}/jobs`, { kind });
      if (isAllowed) {
        expect(response.status).toBe(201);
        expect((await response.json()) as JobDto).toMatchObject({ kind, projectSlug: github, state: 'queued', requestedBy: 'owner' });
      } else {
        expect(response.status).toBe(409);
        expect(await slugOf(response)).toBe('tracker-not-cut-over');
      }
    },
  );

  it('keeps import and kickoff refused on a GitHub project, and writes no job for them', async () => {
    const github = await seedGitHubProject();
    for (const kind of ['import', 'kickoff']) {
      const response = await send('POST', `/api/v1/projects/${github}/jobs`, { kind });
      expect(response.status).toBe(409);
      expect(await slugOf(response)).toBe('tracker-not-cut-over');
    }
    const written = await env.DB.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE project_slug = ?1`).bind(github).first<number>('n');
    expect(written).toBe(0);
  });

  it('refuses a bad kind and a bad role', async () => {
    const project = await seedTrackerProject();
    const badKind = await send('POST', `/api/v1/projects/${project.slug}/jobs`, { kind: 'deploy' });
    expect(badKind.status).toBe(422);
    expect(((await badKind.json()) as { field: string }).field).toBe('kind');
    const badRole = await send('POST', `/api/v1/projects/${project.slug}/jobs`, { kind: 'review', role: 'president' });
    expect(badRole.status).toBe(422);
  });

  it.each([
    ['on the console tracker', async () => (await seedTrackerProject()).slug],
    ['still on GitHub Issues', seedGitHubProject],
  ])('is the owner’s %s: a member, a job and the service identity are refused', async (_name, seed) => {
    const project = { slug: await seed() };
    const memberId = await seedUser('member');
    await seedMembership(OWNER_ACCOUNT_ID, memberId, 'member');
    const member = await sendAsSession({ cookie: await seedSession(memberId) }, 'POST', `/api/v1/projects/${project.slug}/jobs`, { kind: 'slot-dev' }, {}, localEnv({ AUTH_MODE: undefined }));
    expect(member.status).toBe(403);
    const job = await send('POST', `/api/v1/projects/${project.slug}/jobs`, { kind: 'slot-dev' }, { job: jobActor('orchestrator') });
    expect(job.status).toBe(403);
    expect(await slugOf(job)).toBe('owner-only');
    const service = await sendAsService('POST', `/api/v1/projects/${project.slug}/jobs`, { kind: 'slot-dev' });
    expect(service.status).toBe(403);
  });

  it('reads and writes the project placement policy, with validation', async () => {
    const project = await seedTrackerProject();
    const initial = await send('GET', `/api/v1/projects/${project.slug}/runner-policy`);
    expect((await initial.json()) as RunnerPolicyDto).toEqual({ policy: null, effective: { mode: 'any' } });
    const bad = await send('PUT', `/api/v1/projects/${project.slug}/runner-policy`, { mode: 'failover', preferred: 'x', fallback: [] });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { field: string }).field).toBe('preferred');
    const any = await send('PUT', `/api/v1/projects/${project.slug}/runner-policy`, { mode: 'any' });
    expect(any.status).toBe(200);
    expect((await any.json()) as RunnerPolicyDto).toEqual({ policy: { mode: 'any' }, effective: { mode: 'any' } });
  });
});

// #775: the jobs tile reads `runnerAvailability` from the list; the full claim-agreement matrix is the repo's spec.
describe('GET /api/v1/projects/:slug/jobs runnerAvailability', () => {
  const T0 = '2026-11-10T10:00:00.000Z';
  let runners = 0;

  /** A runner of the owner's account that lists only `slug`, so no other case of this file sees it. */
  async function seedRunner(slug: string, lastSeenAt: string | null): Promise<void> {
    runners += 1;
    await env.DB.prepare(
      `INSERT INTO runners (id, account_id, name, public_key_jwk, capabilities, isolation, allowed_projects, version, enrolled_at, last_seen_at, project_scope)
       VALUES (?1, ?2, 'r', ?3, '{"local":true,"maxConcurrency":1}', 'user', ?4, '0.1.0', ?5, ?6, 'selected')`,
    )
      .bind(`01M6YSNJ0000000000JBSR${String(runners).padStart(4, '0')}`, OWNER_ACCOUNT_ID, JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: 'x'.repeat(43) }), JSON.stringify([slug]), T0, lastSeenAt)
      .run();
  }

  it('answers exactly jobs, nextCursor, the availability enum and canRunNow: no runner id, name, host or country', async () => {
    const project = await seedTrackerProject();
    await seedRunner(project.slug, new Date().toISOString());
    const response = await send('GET', `/api/v1/projects/${project.slug}/jobs`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as JobListDto;
    expect(Object.keys(body).sort()).toEqual(['canRunNow', 'jobs', 'nextCursor', 'runnerAvailability']);
    expect(body.runnerAvailability).toBe('ready');
    expect(body.canRunNow).toBe(true);
  });

  // SECURITY review of #804: the reason for `none` is the owner's; a member and a job get the bare enum.
  it('gives the owner alone the reason for none: key sets per role', async () => {
    const lonely = await seedTrackerProject();
    const path = `/api/v1/projects/${lonely.slug}/jobs`;
    const owner = (await (await send('GET', path)).json()) as JobListDto;
    expect(Object.keys(owner).sort()).toEqual(['canRunNow', 'jobs', 'nextCursor', 'runnerAvailability', 'runnerUnavailableReason']);
    expect(owner).toMatchObject({ runnerAvailability: 'none', runnerUnavailableReason: 'no-runner', canRunNow: true });
    const memberId = await seedUser('member-775b');
    await seedMembership(OWNER_ACCOUNT_ID, memberId, 'member');
    const member = await sendAsSession({ cookie: await seedSession(memberId) }, 'GET', path, undefined, {}, localEnv({ AUTH_MODE: undefined }));
    expect(member.status).toBe(200);
    const memberBody = (await member.json()) as JobListDto;
    expect(Object.keys(memberBody).sort()).toEqual(['canRunNow', 'jobs', 'nextCursor', 'runnerAvailability']);
    expect(memberBody.canRunNow).toBe(false);
    const job = await send('GET', path, undefined, { job: jobActor('pm') });
    expect(job.status).toBe(200);
    const jobBody = (await job.json()) as JobListDto;
    expect(Object.keys(jobBody).sort()).toEqual(['canRunNow', 'jobs', 'nextCursor', 'runnerAvailability']);
    expect(jobBody.canRunNow).toBe(false);
    const service = await sendAsService('GET', path);
    expect(service.status).toBe(403);
  });

  it('gives the owner no reason when a runner is ready', async () => {
    const project = await seedTrackerProject();
    await seedRunner(project.slug, new Date().toISOString());
    const owner = (await (await send('GET', `/api/v1/projects/${project.slug}/jobs`)).json()) as JobListDto;
    expect(owner.runnerAvailability).toBe('ready');
    expect('runnerUnavailableReason' in owner).toBe(false);
  });

  it('is none without an eligible runner and offline when the only one is silent', async () => {
    const lonely = await seedTrackerProject();
    expect(((await (await send('GET', `/api/v1/projects/${lonely.slug}/jobs`)).json()) as JobListDto).runnerAvailability).toBe('none');
    const silent = await seedTrackerProject();
    await seedRunner(silent.slug, T0);
    expect(((await (await send('GET', `/api/v1/projects/${silent.slug}/jobs`)).json()) as JobListDto).runnerAvailability).toBe('offline');
  });

  it('is read on a project still on GitHub Issues, by a member and by the project’s job too', async () => {
    const github = await seedGitHubProject();
    await seedRunner(github, new Date().toISOString());
    const owner = (await (await send('GET', `/api/v1/projects/${github}/jobs`)).json()) as JobListDto;
    expect(owner.runnerAvailability).toBe('ready');
    const memberId = await seedUser('member-775');
    await seedMembership(OWNER_ACCOUNT_ID, memberId, 'member');
    const member = await sendAsSession({ cookie: await seedSession(memberId) }, 'GET', `/api/v1/projects/${github}/jobs`, undefined, {}, localEnv({ AUTH_MODE: undefined }));
    expect(member.status).toBe(200);
    expect(((await member.json()) as JobListDto).runnerAvailability).toBe('ready');
    const job = await send('GET', `/api/v1/projects/${github}/jobs`, undefined, { job: jobActor('pm') });
    expect(job.status).toBe(200);
    expect(Object.keys((await job.json()) as JobListDto).sort()).toEqual(['canRunNow', 'jobs', 'nextCursor', 'runnerAvailability']);
  });

  // #775: the flag follows the role in the project's own account, not the first account the caller owns.
  it('says canRunNow per project: an owner of one account reads another account’s project as a member', async () => {
    const user = await seedSessionUser('owner');
    const own = await seedAccountProject(user.account);
    const other = await seedAccount('Other');
    await seedMembership(other.id, user.userId, 'member');
    const theirs = await seedAccountProject(other);
    const bindings = localEnv({ AUTH_MODE: undefined });
    const mine = await sendAsSession(user, 'GET', `/api/v1/projects/${own.slug}/jobs`, undefined, {}, bindings);
    expect(mine.status).toBe(200);
    expect(((await mine.json()) as JobListDto).canRunNow).toBe(true);
    const visited = await sendAsSession(user, 'GET', `/api/v1/projects/${theirs.slug}/jobs`, undefined, {}, bindings);
    expect(visited.status).toBe(200);
    const body = (await visited.json()) as JobListDto;
    expect(body.canRunNow).toBe(false);
    expect('runnerUnavailableReason' in body).toBe(false);
  });
});
