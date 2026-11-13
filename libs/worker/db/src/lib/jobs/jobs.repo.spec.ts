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

/**
 * A runner row. `maxConcurrency` defaults high so the placement specs, which claim several jobs with one runner, judge
 * placement alone; the concurrency specs (#571) set it.
 */
async function runner(
  accountId: string,
  allowed: readonly string[],
  lastSeenAt: string | null = null,
  maxConcurrency = 8,
): Promise<string> {
  const id = ulid('RN');
  await env.DB.prepare(
    `INSERT INTO runners (id, account_id, name, public_key_jwk, capabilities, isolation, allowed_projects, version, enrolled_at, last_seen_at)
     VALUES (?1, ?2, 'r', ?3, ?7, 'user', ?4, '0.1.0', ?5, ?6)`,
  )
    .bind(
      id,
      accountId,
      JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: 'x'.repeat(43) }),
      JSON.stringify(allowed),
      T0,
      lastSeenAt,
      JSON.stringify({ local: true, maxConcurrency }),
    )
    .run();
  return id;
}

/** Stores the runner's allow-list: the claim reads it from the row, not from the caller (#543). */
async function allow(runnerId: string, allowed: readonly string[]): Promise<void> {
  await env.DB.prepare(`UPDATE runners SET allowed_projects = ?2 WHERE id = ?1`).bind(runnerId, JSON.stringify(allowed)).run();
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

const claimAs = (runnerId: string, overrides: Partial<ClaimRequest> = {}): Promise<unknown> =>
  jobs.claim({ runnerId, accountId: ACCOUNT_A, local: true, tokenHash: 'a'.repeat(64), now: T1, leaseUntil: '2026-11-10T10:10:00.000Z', ...overrides });

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
    expect(await claimAs(mine)).toBeNull();
    expect((await jobs.findById(id))?.state).toBe('queued');
  });

  it('honours pinned, any, and the account default', async () => {
    const mac = await runner(ACCOUNT_A, []);
    const vps = await runner(ACCOUNT_A, []);
    const pinned = await project(ACCOUNT_A, JSON.stringify({ mode: 'pinned', runner: mac }));
    const open = await project(ACCOUNT_A, JSON.stringify({ mode: 'any' }));
    const inherits = await project(ACCOUNT_A);
    await allow(mac, [pinned, open, inherits]);
    await allow(vps, [pinned, open, inherits]);
    await enqueue(pinned);
    expect(await claimAs(vps, { tokenHash: 'b'.repeat(64) })).toBeNull();
    expect(((await claimAs(mac)) as { runnerId: string }).runnerId).toBe(mac);

    await enqueue(open);
    expect(((await claimAs(vps, { tokenHash: 'c'.repeat(64) })) as { runnerId: string }).runnerId).toBe(vps);

    await env.DB.prepare(`UPDATE accounts SET default_runner_policy = ?2 WHERE id = ?1`).bind(ACCOUNT_A, JSON.stringify({ mode: 'pinned', runner: mac })).run();
    await enqueue(inherits);
    expect(await claimAs(vps, { tokenHash: 'd'.repeat(64) })).toBeNull();
    expect(((await claimAs(mac, { tokenHash: 'e'.repeat(64) })) as { runnerId: string }).runnerId).toBe(mac);
    await env.DB.prepare(`UPDATE accounts SET default_runner_policy = NULL WHERE id = ?1`).bind(ACCOUNT_A).run();
  });

  it('failover: the fallback claims only while the preferred is silent or revoked', async () => {
    const preferred = await runner(ACCOUNT_A, [], T1);
    const fallback = await runner(ACCOUNT_A, []);
    const slug = await project(ACCOUNT_A, JSON.stringify({ mode: 'failover', preferred, fallback: [fallback], offline_after_seconds: 300 }));
    await allow(fallback, [slug]);
    await enqueue(slug);
    expect(await claimAs(fallback, { tokenHash: 'f'.repeat(64) })).toBeNull();
    await env.DB.prepare(`UPDATE runners SET last_seen_at = ?2 WHERE id = ?1`).bind(preferred, OLD).run();
    expect(((await claimAs(fallback, { tokenHash: '0'.repeat(64) })) as { runnerId: string }).runnerId).toBe(fallback);

    const again = await enqueue(slug);
    await env.DB.prepare(`UPDATE runners SET last_seen_at = ?2, revoked_at = ?2 WHERE id = ?1`).bind(preferred, T1).run();
    expect(((await claimAs(fallback, { tokenHash: '1'.repeat(64) })) as { id: string }).id).toBe(again);
    // A stranger to the policy never claims, whatever its allow-list.
    const stranger = await runner(ACCOUNT_A, [slug]);
    await enqueue(slug);
    expect(await claimAs(stranger, { tokenHash: '2'.repeat(64) })).toBeNull();
  });

  it('takes the highest priority first, then the oldest, and only queued jobs', async () => {
    const slug = await project(ACCOUNT_A);
    const low = await enqueue(slug, ACCOUNT_A, { priority: 0, at: '2026-11-10T09:00:00.000Z' });
    const high = await enqueue(slug, ACCOUNT_A, { priority: 5, at: '2026-11-10T09:30:00.000Z' });
    const r = await runner(ACCOUNT_A, [slug]);
    expect(((await claimAs(r, { tokenHash: '3'.repeat(64) })) as { id: string }).id).toBe(high);
    expect(((await claimAs(r, { tokenHash: '4'.repeat(64) })) as { id: string }).id).toBe(low);
    expect(await claimAs(r, { tokenHash: '5'.repeat(64) })).toBeNull();
  });

  // #543: the poll authenticates the runner, then claims; a narrowing or revoke can commit in between.
  it('claims nothing in a project dropped from the allow-list after the poll read the runner', async () => {
    const dropped = await project(ACCOUNT_A);
    const kept = await project(ACCOUNT_A);
    const r = await runner(ACCOUNT_A, [dropped, kept]);
    const id = await enqueue(dropped);
    expect((await new RunnersRepo(env.DB).findById(r))?.allowedProjects).toContain(dropped);
    await new RunnersRepo(env.DB).setAllowedProjects(ACCOUNT_A, r, [kept], { ...audit('runner.updated'), target: r }, jobs.cancelOutsideStatements(r, [kept], T1));
    expect(await claimAs(r, { tokenHash: '5a'.repeat(32) })).toBeNull();
    expect(await jobs.findById(id)).toMatchObject({ state: 'queued', runnerId: null });
  });

  it('claims nothing for a runner revoked after the poll read it', async () => {
    const slug = await project(ACCOUNT_A);
    const r = await runner(ACCOUNT_A, [slug]);
    const id = await enqueue(slug);
    expect((await new RunnersRepo(env.DB).findById(r))?.revokedAt).toBeNull();
    await new RunnersRepo(env.DB).revoke(ACCOUNT_A, r, T1, { ...audit('runner.revoked'), target: r }, jobs.cancelForRunnerStatements(r, T1));
    expect(await claimAs(r, { tokenHash: '5b'.repeat(32) })).toBeNull();
    expect(await jobs.findById(id)).toMatchObject({ state: 'queued', runnerId: null });
  });
});

// #571, threat model C4 "rogue runner": the pause and the concurrency cap are judged inside the one claim UPDATE.
describe('JobsRepo.claim: runner pause and maxConcurrency', () => {
  const runners = new RunnersRepo(env.DB);
  const pauseAudit = (target: string, accountId = ACCOUNT_A): NewAuditEvent => ({ ...audit('runner.paused', accountId), target });
  // A prefix no other spec of this file uses: the token index is unique across the whole file's jobs.
  const token = (n: number): string => `c0de${n.toString(16)}`.padEnd(64, '0');

  it('a runner at maxConcurrency claims no further job until one ends', async () => {
    const slug = await project(ACCOUNT_A);
    const first = await enqueue(slug);
    const second = await enqueue(slug);
    const r = await runner(ACCOUNT_A, [slug], null, 1);
    expect(((await claimAs(r, { tokenHash: token(1) })) as { id: string }).id).toBe(first);
    expect(await claimAs(r, { tokenHash: token(2) })).toBeNull();
    expect(await jobs.findById(second)).toMatchObject({ state: 'queued', runnerId: null });

    expect(await jobs.finish(first, r, { result: 'finished', summary: 's', metrics: {}, acted: false }, T1, { ...audit('job.finished'), target: first })).toBe(true);
    expect(((await claimAs(r, { tokenHash: token(3) })) as { id: string }).id).toBe(second);
  });

  it('counts claimed and running jobs against a cap above one', async () => {
    const slug = await project(ACCOUNT_A);
    const ids = [await enqueue(slug), await enqueue(slug), await enqueue(slug)];
    const r = await runner(ACCOUNT_A, [slug], null, 2);
    expect(await claimAs(r, { tokenHash: token(4) })).not.toBeNull();
    expect(await jobs.appendEvents(ids[0] ?? '', r, [{ level: 'info', kind: 'started', payload: {} }], T1)).toMatchObject({ held: true });
    expect(await claimAs(r, { tokenHash: token(5) })).not.toBeNull();
    expect(await claimAs(r, { tokenHash: token(6) })).toBeNull();
    expect((await jobs.findById(ids[2] ?? ''))?.state).toBe('queued');
  });

  it('a capabilities row without maxConcurrency counts as one', async () => {
    const slug = await project(ACCOUNT_A);
    await enqueue(slug);
    await enqueue(slug);
    const r = await runner(ACCOUNT_A, [slug]);
    await env.DB.prepare(`UPDATE runners SET capabilities = '{}' WHERE id = ?1`).bind(r).run();
    expect(await claimAs(r, { tokenHash: token(7) })).not.toBeNull();
    expect(await claimAs(r, { tokenHash: token(8) })).toBeNull();
  });

  it('two concurrent polls of one runner at maxConcurrency 1 take one job, not two', async () => {
    const slug = await project(ACCOUNT_A);
    const ids = [await enqueue(slug), await enqueue(slug)];
    const r = await runner(ACCOUNT_A, [slug], null, 1);
    const both = await Promise.all([claimAs(r, { tokenHash: token(9) }), claimAs(r, { tokenHash: token(10) })]);
    expect(both.filter((row) => row !== null)).toHaveLength(1);
    const states = await Promise.all(ids.map(async (id) => (await jobs.findById(id))?.state));
    expect(states.sort()).toEqual(['claimed', 'queued']);
  });

  it('two runners racing for one job: one takes it, and the cap of one never blocks the other', async () => {
    const slug = await project(ACCOUNT_A);
    const id = await enqueue(slug);
    const mac = await runner(ACCOUNT_A, [slug], null, 1);
    const vps = await runner(ACCOUNT_A, [slug], null, 1);
    const both = await Promise.all([claimAs(mac, { tokenHash: token(11) }), claimAs(vps, { tokenHash: token(12) })]);
    expect(both.filter((row) => row !== null)).toHaveLength(1);
    const holder = (await jobs.findById(id))?.runnerId;
    const idle = holder === mac ? vps : mac;
    const next = await enqueue(slug);
    expect(((await claimAs(idle, { tokenHash: token(13) })) as { id: string }).id).toBe(next);
  });

  it('a paused runner claims nothing until its time has passed; the other runner of the account still does', async () => {
    const slug = await project(ACCOUNT_A);
    const id = await enqueue(slug);
    const paused = await runner(ACCOUNT_A, [slug]);
    const other = await runner(ACCOUNT_A, [slug]);
    expect(await runners.pause(ACCOUNT_A, paused, { reason: 'usage-limit', until: '2026-11-10T11:00:00.000Z' }, pauseAudit(paused))).toBe(true);
    expect(await claimAs(paused, { tokenHash: token(14) })).toBeNull();
    expect(await jobs.findById(id)).toMatchObject({ state: 'queued', runnerId: null });
    // The pause ends on its own at `until`: no resume call is needed.
    expect(((await claimAs(paused, { tokenHash: token(15), now: '2026-11-10T11:00:00.000Z', leaseUntil: '2026-11-10T11:05:00.000Z' })) as { id: string }).id).toBe(id);

    const again = await enqueue(slug);
    expect(await claimAs(paused, { tokenHash: token(16) })).toBeNull();
    expect(((await claimAs(other, { tokenHash: token(17) })) as { id: string }).id).toBe(again);
  });

  it('a paused runner of account A changes nothing for account B (two-account)', async () => {
    const mine = await project(ACCOUNT_A);
    const theirs = await project(ACCOUNT_B);
    const a = await runner(ACCOUNT_A, [mine]);
    const b = await runner(ACCOUNT_B, [theirs]);
    await enqueue(theirs, ACCOUNT_B);
    expect(await runners.pause(ACCOUNT_A, a, { reason: 'rate-limit', until: '2026-11-10T11:00:00.000Z' }, pauseAudit(a))).toBe(true);
    // Account A cannot pause B's runner by id: the write names the account it acts in.
    expect(await runners.pause(ACCOUNT_A, b, { reason: 'manual', until: '2026-11-10T11:00:00.000Z' }, pauseAudit(b))).toBe(false);
    expect((await runners.findById(b))?.pause).toBeNull();
    expect(await claimAs(b, { accountId: ACCOUNT_B, tokenHash: token(18) })).not.toBeNull();
  });
});

describe('JobsRepo.finish and events', () => {
  it('writes no event and no audit row when the lease has lapsed', async () => {
    const slug = await project(ACCOUNT_A);
    const id = await enqueue(slug);
    const r = await runner(ACCOUNT_A, [slug]);
    await claimAs(r, { tokenHash: '6'.repeat(64), leaseUntil: '2026-11-10T10:06:00.000Z' });
    const late = await jobs.finish(id, r, { result: 'finished', summary: 's', metrics: {}, acted: false }, '2026-11-10T10:07:00.000Z', audit('job.finished'));
    expect(late).toBe(false);
    expect((await jobs.findById(id))?.state).toBe('claimed');
    const rows = await env.DB.prepare(`SELECT COUNT(*) AS n FROM job_events WHERE job_id = ?1 AND kind = 'finished'`).bind(id).first<{ n: number }>();
    expect(rows?.n).toBe(0);
    const audits = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'job.finished' AND target IS NULL AND account_id = ?1`).bind(ACCOUNT_A).first<{ n: number }>();
    expect(audits?.n).toBe(0);
  });

  // #492: the UPDATE, its event and its audit row are one batch, the last two conditional on the first.
  it('writes one event and one audit row with the finish, and none for a second call', async () => {
    const slug = await project(ACCOUNT_A);
    const id = await enqueue(slug);
    const r = await runner(ACCOUNT_A, [slug]);
    await claimAs(r, { tokenHash: '8'.repeat(64) });
    const finishAudit = { ...audit('job.finished'), target: id };
    const outcome = { result: 'failed' as const, summary: 's', metrics: {}, acted: false };
    expect(await jobs.finish(id, r, outcome, '2026-11-10T10:06:00.000Z', finishAudit)).toBe(true);
    expect(await jobs.finish(id, r, outcome, '2026-11-10T10:06:30.000Z', finishAudit)).toBe(false);
    expect(await jobs.findById(id)).toMatchObject({ state: 'failed', finishedAt: '2026-11-10T10:06:00.000Z' });
    const events = await env.DB.prepare(`SELECT COUNT(*) AS n FROM job_events WHERE job_id = ?1 AND kind = 'failed'`).bind(id).first<{ n: number }>();
    expect(events?.n).toBe(1);
    const audits = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'job.finished' AND target = ?1`).bind(id).first<{ n: number }>();
    expect(audits?.n).toBe(1);
  });

  it('writes no event and no audit row for another runner’s call', async () => {
    const slug = await project(ACCOUNT_A);
    const id = await enqueue(slug);
    const holder = await runner(ACCOUNT_A, [slug]);
    const other = await runner(ACCOUNT_A, []);
    await claimAs(holder, { tokenHash: '9'.repeat(64) });
    const finishAudit = { ...audit('job.finished'), target: id };
    expect(await jobs.finish(id, other, { result: 'finished', summary: 's', metrics: {}, acted: false }, T1, finishAudit)).toBe(false);
    expect((await jobs.findById(id))?.state).toBe('claimed');
    const events = await env.DB.prepare(`SELECT COUNT(*) AS n FROM job_events WHERE job_id = ?1`).bind(id).first<{ n: number }>();
    expect(events?.n).toBe(0);
    const audits = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'job.finished' AND target = ?1`).bind(id).first<{ n: number }>();
    expect(audits?.n).toBe(0);
  });

  it('drops events past the cap and says so', async () => {
    const capped = new JobsRepo(env.DB, 3);
    const slug = await project(ACCOUNT_A);
    const id = await enqueue(slug);
    const r = await runner(ACCOUNT_A, [slug]);
    await claimAs(r, { tokenHash: 'ca'.repeat(32) });
    const event = { level: 'info' as const, kind: 'log' as const, payload: { n: 1 } };
    const first = await capped.appendEvents(id, r, [event, event], T1);
    expect(first).toEqual({ held: true, lastSeq: 2, capped: false });
    const second = await capped.appendEvents(id, r, [event, event], T1);
    expect(second).toEqual({ held: true, lastSeq: 3, capped: true });
    expect((await capped.listEvents(id, 0, 10)).map((row) => row.seq)).toEqual([1, 2, 3]);
  });
});

// #553: the route authenticates the runner, then writes; a narrowing or revoke can commit in between. These change the
// stored row alone, without the cancel batch, so only the write's own guard stands between the runner and the job.
describe('JobsRepo heartbeat, events and finish judge the stored runner row', () => {
  const LEASE = '2026-11-10T10:10:00.000Z';
  const LATER = '2026-11-10T10:12:00.000Z';
  const event = { level: 'info' as const, kind: 'started' as const, payload: {} };
  const outcome = { result: 'finished' as const, summary: 's', metrics: {}, acted: false };

  async function held(tag: string): Promise<{ id: string; r: string; slug: string; kept: string }> {
    const slug = await project(ACCOUNT_A);
    const kept = await project(ACCOUNT_A);
    const r = await runner(ACCOUNT_A, [slug, kept]);
    const id = await enqueue(slug);
    expect(await claimAs(r, { tokenHash: tag.repeat(32), leaseUntil: LEASE })).not.toBeNull();
    return { id, r, slug, kept };
  }

  async function expectNothingWritten(id: string): Promise<void> {
    expect(await jobs.findById(id)).toMatchObject({ state: 'claimed', leaseUntil: LEASE, finishedAt: null });
    expect(await jobs.listEvents(id, 0, 10)).toEqual([]);
    const audits = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'job.finished' AND target = ?1`).bind(id).first<{ n: number }>();
    expect(audits?.n).toBe(0);
  }

  it('writes as before while the stored list keeps the project', async () => {
    const { id, r } = await held('d0');
    expect(await jobs.heartbeat(id, r, T1, LATER)).toBe(true);
    expect(await jobs.appendEvents(id, r, [event], T1)).toEqual({ held: true, lastSeq: 1, capped: false });
    expect((await jobs.findById(id))?.state).toBe('running');
    expect(await jobs.finish(id, r, outcome, T1, { ...audit('job.finished'), target: id })).toBe(true);
  });

  it('refuses every write once the project is dropped from the stored list after the claim', async () => {
    const { id, r, kept } = await held('d1');
    await allow(r, [kept]);
    expect(await jobs.heartbeat(id, r, T1, LATER)).toBe(false);
    expect(await jobs.appendEvents(id, r, [event], T1)).toEqual({ held: false, lastSeq: 0, capped: false });
    expect(await jobs.finish(id, r, outcome, T1, { ...audit('job.finished'), target: id })).toBe(false);
    await expectNothingWritten(id);
  });

  it('refuses every write once the runner is revoked after the claim', async () => {
    const { id, r } = await held('d2');
    await env.DB.prepare(`UPDATE runners SET revoked_at = ?2 WHERE id = ?1`).bind(r, T1).run();
    expect(await jobs.heartbeat(id, r, T1, LATER)).toBe(false);
    expect(await jobs.appendEvents(id, r, [event], T1)).toEqual({ held: false, lastSeq: 0, capped: false });
    expect(await jobs.finish(id, r, outcome, T1, { ...audit('job.finished'), target: id })).toBe(false);
    await expectNothingWritten(id);
  });

  it('refuses events from a runner that does not hold the job', async () => {
    const { id } = await held('d3');
    const other = await runner(ACCOUNT_A, [(await jobs.findById(id))?.projectSlug ?? '']);
    expect(await jobs.appendEvents(id, other, [event], T1)).toEqual({ held: false, lastSeq: 0, capped: false });
    await expectNothingWritten(id);
  });
});

describe('TeamStateRepo.pause and resume', () => {
  const auditCount = async (kind: NewAuditEvent['kind'], slug: string): Promise<number | undefined> =>
    (await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE kind = ?1 AND target = ?2`).bind(kind, slug).first<{ n: number }>())?.n;

  // #492: the write is conditional on the state, so of two racing requests only one takes effect and audits.
  it('takes effect once for two concurrent pauses and once for two concurrent resumes', async () => {
    const slug = await project(ACCOUNT_A);
    const repo = new TeamStateRepo(env.DB);
    const pauseAudit = { ...audit('team.paused'), target: slug };
    const pauses = await Promise.all([repo.pause(slug, 'owner-1', T0, pauseAudit), repo.pause(slug, 'owner-2', T0, pauseAudit)]);
    expect(pauses.filter(Boolean)).toHaveLength(1);
    expect(await auditCount('team.paused', slug)).toBe(1);
    expect(await repo.pause(slug, 'owner-3', T1, pauseAudit)).toBe(false);
    expect((await repo.get(slug)).pausedAt).toBe(T0);
    expect(await auditCount('team.paused', slug)).toBe(1);

    const resumeAudit = { ...audit('team.resumed'), target: slug };
    const resumes = await Promise.all([repo.resume(slug, T1, resumeAudit), repo.resume(slug, T1, resumeAudit)]);
    expect(resumes.filter(Boolean)).toHaveLength(1);
    expect(await auditCount('team.resumed', slug)).toBe(1);
    expect(await repo.get(slug)).toMatchObject({ pausedAt: null, pausedBy: null, failedStreak: 0 });
  });

  it('does not resume a project that was never paused, and writes no audit row', async () => {
    const slug = await project(ACCOUNT_A);
    const repo = new TeamStateRepo(env.DB);
    expect(await repo.resume(slug, T0, { ...audit('team.resumed'), target: slug })).toBe(false);
    expect(await auditCount('team.resumed', slug)).toBe(0);
  });

  it('pauses again after a resume', async () => {
    const slug = await project(ACCOUNT_A);
    const repo = new TeamStateRepo(env.DB);
    const pauseAudit = { ...audit('team.paused'), target: slug };
    expect(await repo.pause(slug, 'owner', T0, pauseAudit)).toBe(true);
    expect(await repo.resume(slug, T1, { ...audit('team.resumed'), target: slug })).toBe(true);
    expect(await repo.pause(slug, 'owner', T1, pauseAudit)).toBe(true);
    expect(await repo.get(slug)).toMatchObject({ pausedAt: T1, pausedBy: 'owner' });
    expect(await auditCount('team.paused', slug)).toBe(2);
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

  // #492: the audit row is conditional on this outcome being the one that paused, inside the outcome's batch.
  it('writes the pause audit only when this outcome paused the project', async () => {
    const pausedCount = async (slug: string): Promise<number | undefined> =>
      (await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'team.paused' AND target = ?1`).bind(slug).first<{ n: number }>())?.n;
    const repo = new TeamStateRepo(env.DB);

    // Paused by the owner first: the streak reaching three pauses nothing and writes no row.
    const owned = await project(ACCOUNT_A);
    await repo.pause(owned, 'owner', T0, { ...audit('team.paused'), target: `${owned}:owner` });
    const ownedAudit = { ...audit('team.paused'), target: owned };
    for (const streak of [1, 2, 3]) {
      expect(await repo.recordOutcome(owned, 'failed', T1, ownedAudit)).toEqual({ failedStreak: streak, paused: false });
    }
    expect(await pausedCount(owned)).toBe(0);

    // Still paused by an earlier streak after a success: the next third failure did not pause it.
    const streaked = await project(ACCOUNT_A);
    const streakAudit = { ...audit('team.paused'), target: streaked };
    for (const streak of [1, 2, 3]) {
      await expect(repo.recordOutcome(streaked, 'failed', T0, streakAudit)).resolves.toMatchObject({ failedStreak: streak });
    }
    expect(await repo.recordOutcome(streaked, 'finished', T1)).toEqual({ failedStreak: 0, paused: false });
    for (const streak of [1, 2, 3]) {
      expect(await repo.recordOutcome(streaked, 'failed', T1, streakAudit)).toEqual({ failedStreak: streak, paused: false });
    }
    expect(await repo.get(streaked)).toMatchObject({ pausedAt: T0, pausedBy: FAILURE_STREAK_PAUSER });
    expect(await pausedCount(streaked)).toBe(1);
  });

  // #571: a usage or rate limit is a quota, not a fault — neither a success nor a failure for the streak.
  it('leaves the streak as it was for a failure on a usage or rate limit, and still counts other failures', async () => {
    const slug = await project(ACCOUNT_A);
    const repo = new TeamStateRepo(env.DB);
    const pauseAudit = { ...audit('team.paused'), target: slug };
    expect(await repo.recordOutcome(slug, 'failed', T0, pauseAudit)).toEqual({ failedStreak: 1, paused: false });
    expect(await repo.recordOutcome(slug, 'failed', T0, pauseAudit)).toEqual({ failedStreak: 2, paused: false });
    for (const reason of ['usage-limit', 'rate-limit', 'usage-limit']) {
      expect(await repo.recordOutcome(slug, 'failed', T0, pauseAudit, reason)).toEqual({ failedStreak: 2, paused: false });
    }
    expect(await repo.get(slug)).toMatchObject({ pausedAt: null, failedStreak: 2 });
    // Any other reason is a failure: the third one pauses.
    expect(await repo.recordOutcome(slug, 'failed', T0, pauseAudit, 'exit')).toEqual({ failedStreak: 3, paused: true });

    // A limit does not reset a streak either, and a fresh project gets no row from one.
    const fresh = await project(ACCOUNT_A);
    expect(await repo.recordOutcome(fresh, 'failed', T0, undefined, 'rate-limit')).toEqual({ failedStreak: 0, paused: false });
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM team_state WHERE project_slug = ?1`).bind(fresh).first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it('cancels a runner’s live jobs outside a narrowed allow-list', async () => {
    const kept = await project(ACCOUNT_A);
    const lost = await project(ACCOUNT_A);
    const r = await runner(ACCOUNT_A, [kept, lost]);
    const id = await enqueue(lost);
    await claimAs(r, { tokenHash: '7'.repeat(64) });
    await new RunnersRepo(env.DB).setAllowedProjects(ACCOUNT_A, r, [kept], audit('runner.updated'), jobs.cancelOutsideStatements(r, [kept], T1));
    expect(await jobs.findById(id)).toMatchObject({ state: 'cancelled', result: { reason: 'runner-allow-list' } });
  });

  it('cancels nothing when the allow-list write changed nothing', async () => {
    const kept = await project(ACCOUNT_A);
    const other = await project(ACCOUNT_A);
    const r = await runner(ACCOUNT_A, [other]);
    const id = await enqueue(other);
    await claimAs(r, { tokenHash: 'ab'.repeat(32) });
    // A narrowing outside this write already stored [kept]; the no-op save after it must not cancel.
    await allow(r, [kept]);
    const runners = new RunnersRepo(env.DB);
    const same = { ...audit('runner.updated'), target: r };
    expect(await runners.setAllowedProjects(ACCOUNT_A, r, [kept], same, jobs.cancelOutsideStatements(r, [kept], T1))).toBe(false);
    expect(await jobs.findById(id)).toMatchObject({ state: 'claimed' });
  });

  it('still cancels a revoked runner’s live jobs for the revoke that won', async () => {
    const slug = await project(ACCOUNT_A);
    const r = await runner(ACCOUNT_A, [slug]);
    const id = await enqueue(slug);
    await claimAs(r, { tokenHash: '0f'.repeat(32) });
    const won = await new RunnersRepo(env.DB).revoke(ACCOUNT_A, r, T1, { ...audit('runner.revoked'), target: r }, jobs.cancelForRunnerStatements(r, T1));
    expect(won).toBe(true);
    expect(await jobs.findById(id)).toMatchObject({ state: 'cancelled', result: { reason: 'runner-revoked' } });
  });

  it('cancels nothing for a revoke that lost the race', async () => {
    const slug = await project(ACCOUNT_A);
    const r = await runner(ACCOUNT_A, [slug]);
    const id = await enqueue(slug);
    await claimAs(r, { tokenHash: 'cd'.repeat(32) });
    const runners = new RunnersRepo(env.DB);
    const revokeAudit = { ...audit('runner.revoked'), target: r };
    // The winner revoked (its own cancel is covered by the revoke route's e2e); the loser comes second.
    expect(await runners.revoke(ACCOUNT_A, r, T0, revokeAudit)).toBe(true);

    // The loser's revoke finds the runner revoked; the job it still holds must stay untouched.
    expect(await runners.revoke(ACCOUNT_A, r, T1, revokeAudit, jobs.cancelForRunnerStatements(r, T1))).toBe(false);
    expect(await jobs.findById(id)).toMatchObject({ state: 'claimed' });
  });
});
