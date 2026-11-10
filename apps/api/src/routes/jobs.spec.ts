import { env } from 'cloudflare:test';
import { OWNER_ACCOUNT_ID, type JobDto, type RunnerPolicyDto } from '@shared/contracts';
import { seedMembership, seedSession, seedUser, sendAsSession } from '../testing/session-kit';
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

  it('refuses a project still on GitHub Issues, a bad kind and a bad role', async () => {
    const github = await seedGitHubProject();
    const notCutOver = await send('POST', `/api/v1/projects/${github}/jobs`, { kind: 'slot-dev' });
    expect(notCutOver.status).toBe(409);
    expect(await slugOf(notCutOver)).toBe('tracker-not-cut-over');
    const project = await seedTrackerProject();
    const badKind = await send('POST', `/api/v1/projects/${project.slug}/jobs`, { kind: 'deploy' });
    expect(badKind.status).toBe(422);
    expect(((await badKind.json()) as { field: string }).field).toBe('kind');
    const badRole = await send('POST', `/api/v1/projects/${project.slug}/jobs`, { kind: 'review', role: 'president' });
    expect(badRole.status).toBe(422);
  });

  it('is the owner’s: a member, a job and the service identity are refused', async () => {
    const project = await seedTrackerProject();
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
