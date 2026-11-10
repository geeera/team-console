import { env } from 'cloudflare:test';
import type { NewAuditEvent } from '../accounts/audit.repo';
import { RunnersRepo } from '../runners/runners.repo';
import { JobsRepo, type ClaimRequest, type NewJob } from './jobs.repo';
import { FAILURE_STREAK_PAUSER, TeamStateRepo } from './team-state.repo';

// #490 review: the claim statement's branches and the repos' guards, directly against D1.

const ACCOUNT_A = '01M6YSNJ00000000000000JBA1';
const ACCOUNT_B = '01M6YSNJ00000000000000JBB2';
const T0 = '2026-11-10T10:00:00.000Z';
const T1 = '2026-11-10T10:05:00.000Z';
const OLD = '2026-11-10T09:00:00.000Z';

let counter = 0;
const ulid = (tag: string): string => {
  counter += 1;
  return `01M6YSNJ00000000000${tag}${String(counter).padStart(5, '0')}`.slice(0, 26);
};
const audit = (kind: NewAuditEvent['kind'], accountId = ACCOUNT_A): NewAuditEvent => ({
  accountId,
  at: T0,
  actorKind: 'system',
  actor: 'spec',
  kind,
  target: null,
});

async function project(accountId: string, policy: string | null = null): Promise<string> {
  counter += 1;
  const slug = `jb-${String(counter)}`;
  await env.DB.prepare(
    `INSERT INTO projects (slug, repo, display_name, cache_epoch, added_at, account_id, tracker, key_prefix, runner_policy)
     VALUES (?1, ?2, ?1, 0, ?3, ?4, 'console', ?5, ?6)`,
  )
    .bind(
      slug,
      `acme/${slug}`,
      T0,
      accountId,
      // Letters only, unique per project: a base-26 label of the counter.
      `J${String.fromCharCode(65 + (counter % 26))}${String.fromCharCode(65 + (Math.floor(counter / 26) % 26))}`,
      policy,
    )
    .run();
  return slug;
}

async function runner(accountId: string, allowed: readonly string[], lastSeenAt: string | null = null): Promise<string> {
  const id = ulid('RN');
  await env.DB.prepare(
    `INSERT INTO runners (id, account_id, name, public_key_jwk, isolation, allowed_projects, version, enrolled_at, last_seen_at)
     VALUES (?1, ?2, 'r', ?3, 'user', ?4, '0.1.0', ?5, ?6)`,
  )
    .bind(id, accountId, JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: 'x'.repeat(43) }), JSON.stringify(allowed), T0, lastSeenAt)
    .run();
  return id;
}

const jobs = new JobsRepo(env.DB);

async function enqueue(slug: string, accountId = ACCOUNT_A, overrides: Partial<NewJob> = {}): Promise<string> {
  const id = ulid('JB');
  const outcome = await jobs.enqueue(
    { id, accountId, projectSlug: slug, kind: 'slot-dev', role: 'orchestrator', payload: {}, priority: 0, requestedBy: 'owner', dedupeKey: null, needsLocal: false, maxMinutes: 90, at: T0, ...overrides },
    audit('job.dispatched', accountId),
  );
  expect(outcome).toBe('ok');
  return id;
}

const claimAs = (runnerId: string, allowed: readonly string[], overrides: Partial<ClaimRequest> = {}): Promise<unknown> =>
  jobs.claim({ runnerId, accountId: ACCOUNT_A, allowedProjects: allowed, local: true, tokenHash: 'a'.repeat(64), now: T1, leaseUntil: '2026-11-10T10:10:00.000Z', ...overrides });

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO accounts (id, slug, name, created_at) VALUES (?1, 'jb-a', 'A', ?2)`).bind(ACCOUNT_A, T0),
    env.DB.prepare(`INSERT INTO accounts (id, slug, name, created_at) VALUES (?1, 'jb-b', 'B', ?2)`).bind(ACCOUNT_B, T0),
  ]);
});

describe('JobsRepo.claim', () => {
  it('refuses a job whose account is not the runner’s, whatever the allow-list says', async () => {
    const theirs = await project(ACCOUNT_B);
    const id = await enqueue(theirs, ACCOUNT_B);
    const mine = await runner(ACCOUNT_A, [theirs]);
    expect(await claimAs(mine, [theirs])).toBeNull();
    expect((await jobs.findById(id))?.state).toBe('queued');
  });

  it('honours pinned, any, and the account default', async () => {
    const mac = await runner(ACCOUNT_A, []);
    const vps = await runner(ACCOUNT_A, []);
    const pinned = await project(ACCOUNT_A, JSON.stringify({ mode: 'pinned', runner: mac }));
    await enqueue(pinned);
    expect(await claimAs(vps, [pinned], { tokenHash: 'b'.repeat(64) })).toBeNull();
    expect(((await claimAs(mac, [pinned])) as { runnerId: string }).runnerId).toBe(mac);

    const open = await project(ACCOUNT_A, JSON.stringify({ mode: 'any' }));
    await enqueue(open);
    expect(((await claimAs(vps, [open], { tokenHash: 'c'.repeat(64) })) as { runnerId: string }).runnerId).toBe(vps);

    await env.DB.prepare(`UPDATE accounts SET default_runner_policy = ?2 WHERE id = ?1`).bind(ACCOUNT_A, JSON.stringify({ mode: 'pinned', runner: mac })).run();
    const inherits = await project(ACCOUNT_A);
    await enqueue(inherits);
    expect(await claimAs(vps, [inherits], { tokenHash: 'd'.repeat(64) })).toBeNull();
    expect(((await claimAs(mac, [inherits], { tokenHash: 'e'.repeat(64) })) as { runnerId: string }).runnerId).toBe(mac);
    await env.DB.prepare(`UPDATE accounts SET default_runner_policy = NULL WHERE id = ?1`).bind(ACCOUNT_A).run();
  });

  it('failover: the fallback claims only while the preferred is silent or revoked', async () => {
    const preferred = await runner(ACCOUNT_A, [], T1);
    const fallback = await runner(ACCOUNT_A, []);
    const slug = await project(ACCOUNT_A, JSON.stringify({ mode: 'failover', preferred, fallback: [fallback], offline_after_seconds: 300 }));
    await enqueue(slug);
    expect(await claimAs(fallback, [slug], { tokenHash: 'f'.repeat(64) })).toBeNull();
    await env.DB.prepare(`UPDATE runners SET last_seen_at = ?2 WHERE id = ?1`).bind(preferred, OLD).run();
    expect(((await claimAs(fallback, [slug], { tokenHash: '0'.repeat(64) })) as { runnerId: string }).runnerId).toBe(fallback);

    const again = await enqueue(slug);
    await env.DB.prepare(`UPDATE runners SET last_seen_at = ?2, revoked_at = ?2 WHERE id = ?1`).bind(preferred, T1).run();
    expect(((await claimAs(fallback, [slug], { tokenHash: '1'.repeat(64) })) as { id: string }).id).toBe(again);
    // A stranger to the policy never claims, whatever its allow-list.
    const stranger = await runner(ACCOUNT_A, []);
    await enqueue(slug);
    expect(await claimAs(stranger, [slug], { tokenHash: '2'.repeat(64) })).toBeNull();
  });

  it('takes the highest priority first, then the oldest, and only queued jobs', async () => {
    const slug = await project(ACCOUNT_A);
    const low = await enqueue(slug, ACCOUNT_A, { priority: 0, at: '2026-11-10T09:00:00.000Z' });
    const high = await enqueue(slug, ACCOUNT_A, { priority: 5, at: '2026-11-10T09:30:00.000Z' });
    const r = await runner(ACCOUNT_A, []);
    expect(((await claimAs(r, [slug], { tokenHash: '3'.repeat(64) })) as { id: string }).id).toBe(high);
    expect(((await claimAs(r, [slug], { tokenHash: '4'.repeat(64) })) as { id: string }).id).toBe(low);
    expect(await claimAs(r, [slug], { tokenHash: '5'.repeat(64) })).toBeNull();
  });
});

describe('JobsRepo.finish and events', () => {
  it('writes no event and no audit row when the lease has lapsed', async () => {
    const slug = await project(ACCOUNT_A);
    const id = await enqueue(slug);
    const r = await runner(ACCOUNT_A, []);
    await claimAs(r, [slug], { tokenHash: '6'.repeat(64), leaseUntil: '2026-11-10T10:06:00.000Z' });
    const late = await jobs.finish(id, r, { result: 'finished', summary: 's', metrics: {}, acted: false }, '2026-11-10T10:07:00.000Z', audit('job.finished'));
    expect(late).toBe(false);
    expect((await jobs.findById(id))?.state).toBe('claimed');
    const rows = await env.DB.prepare(`SELECT COUNT(*) AS n FROM job_events WHERE job_id = ?1 AND kind = 'finished'`).bind(id).first<{ n: number }>();
    expect(rows?.n).toBe(0);
    const audits = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'job.finished' AND target IS NULL AND account_id = ?1`).bind(ACCOUNT_A).first<{ n: number }>();
    expect(audits?.n).toBe(0);
  });

  it('drops events past the cap and says so', async () => {
    const capped = new JobsRepo(env.DB, 3);
    const slug = await project(ACCOUNT_A);
    const id = await enqueue(slug);
    const event = { level: 'info' as const, kind: 'log' as const, payload: { n: 1 } };
    const first = await capped.appendEvents(id, [event, event], T1);
    expect(first).toEqual({ lastSeq: 2, capped: false });
    const second = await capped.appendEvents(id, [event, event], T1);
    expect(second).toEqual({ lastSeq: 3, capped: true });
    expect((await capped.listEvents(id, 0, 10)).map((row) => row.seq)).toEqual([1, 2, 3]);
  });
});

describe('TeamStateRepo.recordOutcome', () => {
  it('counts a streak, pauses on the third failure with an audit row, and resets on success', async () => {
    const slug = await project(ACCOUNT_A);
    const repo = new TeamStateRepo(env.DB);
    const pauseAudit = { ...audit('team.paused'), target: slug };
    expect(await repo.recordOutcome(slug, 'failed', T0, pauseAudit)).toEqual({ failedStreak: 1, paused: false });
    expect(await repo.recordOutcome(slug, 'failed', T0, pauseAudit)).toEqual({ failedStreak: 2, paused: false });
    expect(await repo.recordOutcome(slug, 'failed', T0, pauseAudit)).toEqual({ failedStreak: 3, paused: true });
    expect((await repo.get(slug)).pausedBy).toBe(FAILURE_STREAK_PAUSER);
    const rows = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'team.paused' AND target = ?1`).bind(slug).first<{ n: number }>();
    expect(rows?.n).toBe(1);
    expect(await repo.recordOutcome(slug, 'failed', T0, pauseAudit)).toEqual({ failedStreak: 4, paused: false });
    await repo.resume(slug, T1, { ...audit('team.resumed'), target: slug });
    expect(await repo.get(slug)).toMatchObject({ pausedAt: null, failedStreak: 0 });
    expect(await repo.recordOutcome(slug, 'finished', T1)).toEqual({ failedStreak: 0, paused: false });
  });

  it('cancels a runner’s live jobs outside a narrowed allow-list', async () => {
    const kept = await project(ACCOUNT_A);
    const lost = await project(ACCOUNT_A);
    const r = await runner(ACCOUNT_A, [kept, lost]);
    const id = await enqueue(lost);
    await claimAs(r, [kept, lost], { tokenHash: '7'.repeat(64) });
    await new RunnersRepo(env.DB).setAllowedProjects(ACCOUNT_A, r, [kept], audit('runner.updated'), jobs.cancelOutsideStatements(r, [kept], T1));
    expect(await jobs.findById(id)).toMatchObject({ state: 'cancelled', result: { reason: 'runner-allow-list' } });
  });
});
