import { env } from 'cloudflare:test';
import type { NewAuditEvent } from '../accounts/audit.repo';
import { RunnersRepo } from '../runners/runners.repo';
import { JobsRepo, type ClaimRequest, type NewJob } from './jobs.repo';
import { FAILURE_STREAK_PAUSER, RUNNER_EXCLUSION_BUDGET, RUNNER_EXCLUSION_WINDOW_MS, TeamStateRepo } from './team-state.repo';

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

interface RunnerRowOptions {
  readonly lastSeenAt?: string | null;
  readonly maxConcurrency?: number;
  /** `capabilities.accessSources` (#775); absent declares nothing. */
  readonly accessSources?: readonly string[];
  /** D3: who enrolled the runner. */
  readonly enrolledBy?: string | null;
  /** A hosted runner (C12 row 6); the identity columns are fixed at insert. */
  readonly hosted?: boolean;
  readonly isolation?: 'user' | 'actions-ephemeral';
}

/**
 * A runner row with `selected` and the list, or `'all'` (#775). `maxConcurrency` defaults high so the placement specs,
 * which claim several jobs with one runner, judge placement alone; the concurrency specs (#571) set it.
 */
async function runner(
  accountId: string,
  allowed: readonly string[] | 'all',
  lastSeenAt: string | null = null,
  maxConcurrency = 8,
  options: RunnerRowOptions = {},
): Promise<string> {
  const id = ulid('RN');
  const capabilities: Record<string, unknown> = { local: true, maxConcurrency: options.maxConcurrency ?? maxConcurrency };
  if (options.accessSources !== undefined) {
    capabilities['accessSources'] = options.accessSources;
  }
  await env.DB.prepare(
    `INSERT INTO runners (id, account_id, name, public_key_jwk, capabilities, isolation, allowed_projects, version, enrolled_at, last_seen_at, project_scope, enrolled_by, hosted)
     VALUES (?1, ?2, 'r', ?3, ?7, ?10, ?4, '0.1.0', ?5, ?6, ?8, ?9, ?11)`,
  )
    .bind(
      id,
      accountId,
      JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: 'x'.repeat(43) }),
      JSON.stringify(allowed === 'all' ? [] : allowed),
      T0,
      options.lastSeenAt ?? lastSeenAt,
      JSON.stringify(capabilities),
      allowed === 'all' ? 'all' : 'selected',
      options.enrolledBy ?? null,
      options.isolation ?? 'user',
      options.hosted === true ? 1 : 0,
    )
    .run();
  return id;
}

/** A distinct token hash per claim of the scope cases. */
const tok = (n: number): string => `5c0de${n.toString(16)}`.padEnd(64, '0');

/**
 * The project's access source, written as `TeamConfigRepo` writes it (0032: the column follows the document, and the
 * document moves one revision at a time).
 */
async function setAccessSource(slug: string, accessSource: 'subscription' | 'api_key'): Promise<void> {
  const config = JSON.stringify({ schema: 'team-config/v1', access: { source: accessSource } });
  const moved = await env.DB.prepare(`UPDATE team_configs SET config = ?2, revision = revision + 1 WHERE project_slug = ?1`).bind(slug, config).run();
  if (moved.meta.changes === 0) {
    await env.DB.prepare(`INSERT INTO team_configs (project_slug, revision, config, updated_at, updated_by) VALUES (?1, 1, ?2, ?3, 'spec')`).bind(slug, config, T0).run();
  }
  await env.DB.prepare(`UPDATE projects SET access_source = ?2 WHERE slug = ?1`).bind(slug, accessSource).run();
}

/** A job well ahead of any queued leftover of the account: an `all` runner sees them all (#775). */
const URGENT = 1000;

/** A project row with its creator (D3) and access source. */
async function projectBy(accountId: string, createdBy: string | null, accessSource: 'subscription' | 'api_key' = 'subscription'): Promise<string> {
  const slug = await project(accountId);
  await env.DB.prepare(`UPDATE projects SET created_by = ?2 WHERE slug = ?1`).bind(slug, createdBy).run();
  if (accessSource !== 'subscription') {
    await setAccessSource(slug, accessSource);
  }
  return slug;
}

/** `n` owners of `accountId` (D3 judges the count, never who they are). */
async function owners(accountId: string, n: number): Promise<void> {
  for (let index = 0; index < n; index += 1) {
    const userId = ulid('MB');
    await env.DB.batch([
      env.DB
        .prepare(`INSERT INTO users (id, provider, provider_user_id, login, created_at, last_seen_at) VALUES (?1, 'github', ?2, ?3, ?4, ?4)`)
        .bind(userId, String(900000 + counter), `o-${String(counter)}`, T0),
      env.DB.prepare(`INSERT INTO account_members (account_id, user_id, role, joined_at) VALUES (?1, ?2, 'owner', ?3)`).bind(accountId, userId, T0),
    ]);
  }
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

// The entitled concurrency (#746) is account-wide and these cases share the account: the top of the override's
// range keeps it out of the rules each case is about; the concurrency specs set their own.
beforeAll(async () => {
  const insert = `INSERT INTO accounts (id, slug, name, entitlements, created_at) VALUES (?1, ?2, ?3, '{"max_concurrency":32}', ?4)`;
  await env.DB.batch([
    env.DB.prepare(insert).bind(ACCOUNT_A, 'jb-a', 'A', T0),
    env.DB.prepare(insert).bind(ACCOUNT_B, 'jb-b', 'B', T0),
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
  // #775: `all` serves every project of the account, including one created after the runner was enrolled, and only
  // of the account; `selected` stays the list.
  it('all: claims a job of any project of the account, a new one included, and never another account’s', async () => {
    const mine = await project(ACCOUNT_A);
    const theirs = await project(ACCOUNT_B);
    const all = await runner(ACCOUNT_A, 'all');
    const listed = await runner(ACCOUNT_A, [mine]);
    const first = await enqueue(mine, ACCOUNT_A, { priority: URGENT });
    await enqueue(theirs, ACCOUNT_B);
    expect(((await claimAs(all, { tokenHash: tok(30) })) as { id: string }).id).toBe(first);
    // A project that did not exist when the runner was enrolled.
    const later = await project(ACCOUNT_A);
    const second = await enqueue(later, ACCOUNT_A, { priority: URGENT });
    expect(await claimAs(listed, { tokenHash: tok(31) })).toBeNull();
    expect(((await claimAs(all, { tokenHash: tok(32) })) as { id: string }).id).toBe(second);
    // Account B's job stays where it is, whatever the scope says (the account match is a separate term).
    expect(await claimAs(all, { accountId: ACCOUNT_B, tokenHash: tok(34) })).toBeNull();
    const row = await env.DB.prepare(`SELECT state, runner_id FROM jobs WHERE project_slug = ?1`).bind(theirs).first<{ state: string; runner_id: null }>();
    expect(row).toEqual({ state: 'queued', runner_id: null });
  });

  // Owner decision D3 (2026-11-17): with more than one owner, a subscription runner under `all` serves the enrolling
  // owner's projects only; an API-key runner, or a one-owner account, is not held back; selection always works.
  it('D3: in a two-owner account an all-scope subscription runner serves its enroller’s projects only', async () => {
    const account = '01M6YSNJ00000000000000JBD3';
    await env.DB.prepare(`INSERT INTO accounts (id, slug, name, entitlements, created_at) VALUES (?1, 'jb-d3', 'D3', '{"max_concurrency":32}', ?2)`).bind(account, T0).run();
    const mine = await projectBy(account, 'owner-1');
    const theirs = await projectBy(account, 'owner-2');
    const legacy = await projectBy(account, null);
    const subscription = await runner(account, 'all', null, 8, { enrolledBy: 'owner-1', accessSources: ['subscription'] });
    const undeclared = await runner(account, 'all', null, 8, { enrolledBy: 'owner-1' });
    const apiKey = await runner(account, 'all', null, 8, { enrolledBy: 'owner-1', accessSources: ['api_key'] });
    const claimIn = (runnerId: string, n: number) => claimAs(runnerId, { accountId: account, tokenHash: tok(n) });

    // One owner: D3 does not apply; everything of the account is served.
    await owners(account, 1);
    const theirsJob = await enqueue(theirs, account);
    expect(((await claimIn(subscription, 40)) as { id: string }).id).toBe(theirsJob);

    // A second owner: the other owner's project and a project with no recorded creator are not the subscription's.
    await owners(account, 1);
    const theirsAgain = await enqueue(theirs, account);
    const legacyJob = await enqueue(legacy, account);
    const mineJob = await enqueue(mine, account);
    expect(((await claimIn(subscription, 41)) as { id: string }).id).toBe(mineJob);
    expect(await claimIn(subscription, 42)).toBeNull();
    expect(await claimIn(undeclared, 43)).toBeNull();
    // An API-key runner is not a subscription doing another owner's work: `all` stays the whole account.
    await setAccessSource(theirs, 'api_key');
    await setAccessSource(legacy, 'api_key');
    expect(((await claimIn(apiKey, 44)) as { id: string }).id).toBe(theirsAgain);
    expect(((await claimIn(apiKey, 45)) as { id: string }).id).toBe(legacyJob);
    // Explicit selection serves the other owner's project whatever the credential.
    await setAccessSource(theirs, 'subscription');
    const picked = await enqueue(theirs, account);
    await new RunnersRepo(env.DB).setScope(account, subscription, { projectScope: 'selected', allowedProjects: [theirs] }, 'owner-1', audit('runner.scope-changed', account));
    expect(((await claimIn(subscription, 46)) as { id: string }).id).toBe(picked);
  });

  // #775 (SECURITY question 7): the declaration only narrows; a runner that declares nothing is not narrowed.
  it('accessSources: a runner declaring subscription never claims an api_key job; an undeclared one is judged by the row alone', async () => {
    const account = '01M6YSNJ00000000000000JBS7';
    await env.DB.prepare(`INSERT INTO accounts (id, slug, name, entitlements, created_at) VALUES (?1, 'jb-s7', 'S7', '{"max_concurrency":32}', ?2)`).bind(account, T0).run();
    const byKey = await projectBy(account, null, 'api_key');
    const bySubscription = await projectBy(account, null, 'subscription');
    const declared = await runner(account, 'all', null, 8, { accessSources: ['subscription'] });
    const undeclared = await runner(account, 'all');
    const keyJob = await enqueue(byKey, account);
    const subscriptionJob = await enqueue(bySubscription, account);
    const claimIn = (runnerId: string, n: number) => claimAs(runnerId, { accountId: account, tokenHash: tok(n) });
    expect(((await claimIn(declared, 50)) as { id: string }).id).toBe(subscriptionJob);
    expect(await claimIn(declared, 51)).toBeNull();
    expect(((await claimIn(undeclared, 52)) as { id: string }).id).toBe(keyJob);
  });

  it('claims nothing in a project dropped from the allow-list after the poll read the runner', async () => {
    const dropped = await project(ACCOUNT_A);
    const kept = await project(ACCOUNT_A);
    const r = await runner(ACCOUNT_A, [dropped, kept]);
    const id = await enqueue(dropped);
    expect((await new RunnersRepo(env.DB).findById(r))?.allowedProjects).toContain(dropped);
    await new RunnersRepo(env.DB).setScope(ACCOUNT_A, r, { projectScope: 'selected', allowedProjects: [kept] }, 'owner', { ...audit('runner.scope-changed'), target: r }, jobs.cancelUnservedStatements(r, T1));
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
    expect(await repo.recordOutcome(slug, 'failed', T0, pauseAudit)).toEqual({ failedStreak: 1, paused: false, excluded: false });
    expect(await repo.recordOutcome(slug, 'failed', T0, pauseAudit)).toEqual({ failedStreak: 2, paused: false, excluded: false });
    expect(await repo.recordOutcome(slug, 'failed', T0, pauseAudit)).toEqual({ failedStreak: 3, paused: true, excluded: false });
    expect((await repo.get(slug)).pausedBy).toBe(FAILURE_STREAK_PAUSER);
    const rows = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'team.paused' AND target = ?1`).bind(slug).first<{ n: number }>();
    expect(rows?.n).toBe(1);
    expect(await repo.recordOutcome(slug, 'failed', T0, pauseAudit)).toEqual({ failedStreak: 4, paused: false, excluded: false });
    await repo.resume(slug, T1, { ...audit('team.resumed'), target: slug });
    expect(await repo.get(slug)).toMatchObject({ pausedAt: null, failedStreak: 0 });
    expect(await repo.recordOutcome(slug, 'finished', T1)).toEqual({ failedStreak: 0, paused: false, excluded: false });
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
      expect(await repo.recordOutcome(owned, 'failed', T1, ownedAudit)).toEqual({ failedStreak: streak, paused: false, excluded: false });
    }
    expect(await pausedCount(owned)).toBe(0);

    // Still paused by an earlier streak after a success: the next third failure did not pause it.
    const streaked = await project(ACCOUNT_A);
    const streakAudit = { ...audit('team.paused'), target: streaked };
    for (const streak of [1, 2, 3]) {
      await expect(repo.recordOutcome(streaked, 'failed', T0, streakAudit)).resolves.toMatchObject({ failedStreak: streak });
    }
    expect(await repo.recordOutcome(streaked, 'finished', T1)).toEqual({ failedStreak: 0, paused: false, excluded: false });
    for (const streak of [1, 2, 3]) {
      expect(await repo.recordOutcome(streaked, 'failed', T1, streakAudit)).toEqual({ failedStreak: streak, paused: false, excluded: false });
    }
    expect(await repo.get(streaked)).toMatchObject({ pausedAt: T0, pausedBy: FAILURE_STREAK_PAUSER });
    expect(await pausedCount(streaked)).toBe(1);
  });

  // #571, #596: a usage or rate limit is a quota, not a fault — but only when the runner's pause row backs the claim.
  describe('a failure on a usage or rate limit', () => {
    // The exclusion budgets are sized from the entitled concurrency (#701, #705): these cases read the free tier's.
    const entitlementsOfA = (json: string) =>
      env.DB.prepare(`UPDATE accounts SET entitlements = ?2 WHERE id = ?1`).bind(ACCOUNT_A, json).run();
    beforeAll(async () => {
      await entitlementsOfA('{}');
    });
    afterAll(async () => {
      await entitlementsOfA('{"max_concurrency":32}');
    });

    const PAUSED_UNTIL = '2026-11-10T11:00:00.000Z';
    const limitOf = (runnerId: string, reason: unknown, accountId = ACCOUNT_A) => ({
      reason,
      runnerId,
      accountId,
      audit: { ...audit('job.streak-excluded', accountId), actorKind: 'runner' as const, actor: runnerId, target: `job-${runnerId}` },
    });
    const pauseRunner = async (runnerId: string, until: string): Promise<void> => {
      await env.DB.prepare(`UPDATE runners SET paused_until = ?2, pause_reason = 'usage-limit' WHERE id = ?1`).bind(runnerId, until).run();
    };
    const excludedCount = async (runnerId: string): Promise<number | undefined> =>
      (
        await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'job.streak-excluded' AND actor = ?1`)
          .bind(runnerId)
          .first<{ n: number }>()
      )?.n;

    it('leaves the streak as it was, with an audit row, while the finishing runner holds a pause', async () => {
      const slug = await project(ACCOUNT_A);
      const paused = await runner(ACCOUNT_A, [slug]);
      await pauseRunner(paused, PAUSED_UNTIL);
      const repo = new TeamStateRepo(env.DB);
      const pauseAudit = { ...audit('team.paused'), target: slug };
      expect(await repo.recordOutcome(slug, 'failed', T0, pauseAudit)).toEqual({ failedStreak: 1, paused: false, excluded: false });
      expect(await repo.recordOutcome(slug, 'failed', T0, pauseAudit)).toEqual({ failedStreak: 2, paused: false, excluded: false });
      for (const reason of ['usage-limit', 'rate-limit', 'usage-limit']) {
        expect(await repo.recordOutcome(slug, 'failed', T0, pauseAudit, limitOf(paused, reason))).toEqual({
          failedStreak: 2,
          paused: false,
          excluded: true,
        });
      }
      expect(await repo.get(slug)).toMatchObject({ pausedAt: null, failedStreak: 2 });
      expect(await excludedCount(paused)).toBe(3);
      // Any other reason is a failure, pause or not: the third one pauses.
      expect(await repo.recordOutcome(slug, 'failed', T0, pauseAudit, limitOf(paused, 'exit'))).toEqual({
        failedStreak: 3,
        paused: true,
        excluded: false,
      });
      expect(await excludedCount(paused)).toBe(3);

      // A limit does not reset a streak either, and a fresh project gets no row from one.
      const fresh = await project(ACCOUNT_A);
      expect(await repo.recordOutcome(fresh, 'failed', T0, undefined, limitOf(paused, 'rate-limit'))).toEqual({
        failedStreak: 0,
        paused: false,
        excluded: true,
      });
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM team_state WHERE project_slug = ?1`).bind(fresh).first<{ n: number }>();
      expect(row?.n).toBe(0);
    });

    it('counts it when the runner holds no pause, and the third such failure pauses the project', async () => {
      const slug = await project(ACCOUNT_A);
      const unpaused = await runner(ACCOUNT_A, [slug]);
      const repo = new TeamStateRepo(env.DB);
      const pauseAudit = { ...audit('team.paused'), target: slug };
      for (const [streak, reason] of [[1, 'usage-limit'], [2, 'rate-limit']] as const) {
        expect(await repo.recordOutcome(slug, 'failed', T0, pauseAudit, limitOf(unpaused, reason))).toEqual({
          failedStreak: streak,
          paused: false,
          excluded: false,
        });
      }
      expect(await repo.recordOutcome(slug, 'failed', T0, pauseAudit, limitOf(unpaused, 'usage-limit'))).toEqual({
        failedStreak: 3,
        paused: true,
        excluded: false,
      });
      expect(await repo.get(slug)).toMatchObject({ pausedAt: T0, pausedBy: FAILURE_STREAK_PAUSER });
      expect(await excludedCount(unpaused)).toBe(0);
      const pauses = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'team.paused' AND target = ?1`)
        .bind(slug)
        .first<{ n: number }>();
      expect(pauses?.n).toBe(1);
    });

    // #658: a pause has no minimum length and the runner can lift it at once, so the pause alone is no cap.
    it('counts a runner’s limit failures once it has used its exclusion budget in the window', async () => {
      const slug = await project(ACCOUNT_A);
      const rogue = await runner(ACCOUNT_A, [slug]);
      const other = await runner(ACCOUNT_A, [slug]);
      await pauseRunner(rogue, PAUSED_UNTIL);
      await pauseRunner(other, PAUSED_UNTIL);
      const repo = new TeamStateRepo(env.DB);
      const pauseAudit = { ...audit('team.paused'), target: slug };
      for (let i = 0; i < RUNNER_EXCLUSION_BUDGET; i += 1) {
        expect(await repo.recordOutcome(slug, 'failed', T0, pauseAudit, limitOf(rogue, 'usage-limit'))).toMatchObject({ excluded: true });
      }
      expect(await excludedCount(rogue)).toBe(RUNNER_EXCLUSION_BUDGET);
      // Past the budget the failures count, and the third in a row pauses the project.
      for (const streak of [1, 2]) {
        expect(await repo.recordOutcome(slug, 'failed', T0, pauseAudit, limitOf(rogue, 'usage-limit'))).toEqual({
          failedStreak: streak,
          paused: false,
          excluded: false,
        });
      }
      expect(await repo.recordOutcome(slug, 'failed', T0, pauseAudit, limitOf(rogue, 'usage-limit'))).toMatchObject({ failedStreak: 3, paused: true });
      expect(await excludedCount(rogue)).toBe(RUNNER_EXCLUSION_BUDGET);

      // The runner's budget follows it to another project; a well-behaved runner there is still excluded.
      const elsewhere = await project(ACCOUNT_A);
      expect(await repo.recordOutcome(elsewhere, 'failed', T0, undefined, limitOf(rogue, 'usage-limit'))).toMatchObject({ failedStreak: 1, excluded: false });
      expect(await repo.recordOutcome(elsewhere, 'failed', T0, undefined, limitOf(other, 'rate-limit'))).toMatchObject({ failedStreak: 1, excluded: true });
    });

    // #701, #705: the project's budget, and both budgets sized from concurrency.
    describe('budgets across runners and concurrency', () => {
      let accountSeq = 0;
      /** An account entitled to `maxConcurrency` jobs at once, through the operator's override. */
      const entitledAccount = async (maxConcurrency: number): Promise<string> => {
        accountSeq += 1;
        const id = ulid('EA');
        await env.DB.prepare(
          `INSERT INTO accounts (id, slug, name, plan, entitlements, created_at) VALUES (?1, ?2, 'E', 'team', ?3, ?4)`,
        )
          .bind(id, `jb-ent-${String(accountSeq)}`, JSON.stringify({ max_concurrency: maxConcurrency }), T0)
          .run();
        return id;
      };
      const pausedRunner = async (accountId: string, slug: string, maxConcurrency = 1): Promise<string> => {
        const id = await runner(accountId, [slug], null, maxConcurrency);
        await pauseRunner(id, PAUSED_UNTIL);
        return id;
      };
      const projectExcluded = async (slug: string): Promise<number | undefined> =>
        (
          await env.DB.prepare(
            `SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'job.streak-excluded' AND json_extract(details, '$.slug') = ?1`,
          )
            .bind(slug)
            .first<{ n: number }>()
        )?.n;

      it('caps an Actions project however many one-job runner identities fail on a limit', async () => {
        const slug = await project(ACCOUNT_A);
        const repo = new TeamStateRepo(env.DB);
        const pauseAudit = { ...audit('team.paused'), target: slug };
        // #669: every Actions job brings a fresh runner id, so a per-runner count alone never fills up.
        const ephemeral = async (): Promise<string> => {
          const id = await pausedRunner(ACCOUNT_A, slug);
          await env.DB.prepare(`UPDATE runners SET isolation = 'actions-ephemeral', capabilities = ?2 WHERE id = ?1`)
            .bind(id, JSON.stringify({ local: false, maxConcurrency: 1 }))
            .run();
          return id;
        };
        for (let i = 0; i < RUNNER_EXCLUSION_BUDGET; i += 1) {
          expect(await repo.recordOutcome(slug, 'failed', T0, pauseAudit, limitOf(await ephemeral(), 'usage-limit'))).toMatchObject({
            excluded: true,
          });
        }
        for (const streak of [1, 2]) {
          expect(await repo.recordOutcome(slug, 'failed', T0, pauseAudit, limitOf(await ephemeral(), 'usage-limit'))).toEqual({
            failedStreak: streak,
            paused: false,
            excluded: false,
          });
        }
        expect(await repo.recordOutcome(slug, 'failed', T0, pauseAudit, limitOf(await ephemeral(), 'rate-limit'))).toMatchObject({
          failedStreak: 3,
          paused: true,
        });
        expect(await projectExcluded(slug)).toBe(RUNNER_EXCLUSION_BUDGET);
        // Another project of the account keeps its own budget.
        const other = await project(ACCOUNT_A);
        expect(await repo.recordOutcome(other, 'failed', T0, undefined, limitOf(await ephemeral(), 'usage-limit'))).toMatchObject({
          failedStreak: 0,
          excluded: true,
        });
      });

      it('gives several runners on one project one budget between them, not one each', async () => {
        const slug = await project(ACCOUNT_A);
        const runners = [await pausedRunner(ACCOUNT_A, slug), await pausedRunner(ACCOUNT_A, slug), await pausedRunner(ACCOUNT_A, slug)];
        const repo = new TeamStateRepo(env.DB);
        const outcomes = [];
        for (let round = 0; round < 3; round += 1) {
          for (const id of runners) {
            outcomes.push((await repo.recordOutcome(slug, 'failed', T0, undefined, limitOf(id, 'usage-limit'))).excluded);
          }
        }
        expect(outcomes.filter(Boolean)).toHaveLength(RUNNER_EXCLUSION_BUDGET);
        expect(await repo.get(slug)).toMatchObject({ pausedBy: FAILURE_STREAK_PAUSER });
        for (const id of runners) {
          expect(await excludedCount(id)).toBeLessThan(RUNNER_EXCLUSION_BUDGET);
        }
      });

      it('counts the excluded row under the project it was recorded for, whatever slug the caller put in its details', async () => {
        const slug = await project(ACCOUNT_A);
        const id = await pausedRunner(ACCOUNT_A, slug);
        const claim = limitOf(id, 'usage-limit');
        const repo = new TeamStateRepo(env.DB);
        await repo.recordOutcome(slug, 'failed', T0, undefined, { ...claim, audit: { ...claim.audit, details: { slug: 'elsewhere' } } });
        expect(await projectExcluded(slug)).toBe(1);
        expect(await projectExcluded('elsewhere')).toBe(0);
      });

      it('sizes both budgets from a concurrency above the floor when the account is entitled to it', async () => {
        const concurrency = RUNNER_EXCLUSION_BUDGET + 3;
        const accountId = await entitledAccount(concurrency);
        const slug = await project(accountId);
        const wide = await pausedRunner(accountId, slug, concurrency);
        const repo = new TeamStateRepo(env.DB);
        const pauseAudit = { ...audit('team.paused', accountId), target: slug };
        // A runner holding `concurrency` jobs hits its quota: every one of them is left out, nothing pauses.
        for (let i = 0; i < concurrency; i += 1) {
          expect(await repo.recordOutcome(slug, 'failed', T0, pauseAudit, limitOf(wide, 'usage-limit', accountId))).toEqual({
            failedStreak: 0,
            paused: false,
            excluded: true,
          });
        }
        expect(await repo.recordOutcome(slug, 'failed', T0, pauseAudit, limitOf(wide, 'usage-limit', accountId))).toMatchObject({
          failedStreak: 1,
          excluded: false,
        });

        // The same burst spread over one-slot runners of a well-behaved account: no false pause either.
        const spread = await project(accountId);
        for (let i = 0; i < concurrency; i += 1) {
          const id = await pausedRunner(accountId, spread);
          expect(await repo.recordOutcome(spread, 'failed', T0, undefined, limitOf(id, 'rate-limit', accountId))).toMatchObject({
            failedStreak: 0,
            excluded: true,
          });
        }
        const extra = await pausedRunner(accountId, spread);
        expect(await repo.recordOutcome(spread, 'failed', T0, undefined, limitOf(extra, 'rate-limit', accountId))).toMatchObject({
          failedStreak: 1,
          excluded: false,
        });
      });

      it('caps a declared concurrency at the account’s entitlement', async () => {
        // ACCOUNT_A is on the free plan: one job at a time, so a runner declaring eight gets the floor, not eight.
        const slug = await project(ACCOUNT_A);
        const overDeclared = await pausedRunner(ACCOUNT_A, slug, RUNNER_EXCLUSION_BUDGET + 3);
        const repo = new TeamStateRepo(env.DB);
        for (let i = 0; i < RUNNER_EXCLUSION_BUDGET; i += 1) {
          expect(await repo.recordOutcome(slug, 'failed', T0, undefined, limitOf(overDeclared, 'usage-limit'))).toMatchObject({ excluded: true });
        }
        expect(await repo.recordOutcome(slug, 'failed', T0, undefined, limitOf(overDeclared, 'usage-limit'))).toMatchObject({
          failedStreak: 1,
          excluded: false,
        });
        // The per-runner budget follows the same cap on a project with budget to spare.
        const accountId = await entitledAccount(RUNNER_EXCLUSION_BUDGET + 3);
        const roomy = await project(accountId);
        const narrow = await pausedRunner(accountId, roomy, 1);
        for (let i = 0; i < RUNNER_EXCLUSION_BUDGET; i += 1) {
          await repo.recordOutcome(roomy, 'failed', T0, undefined, limitOf(narrow, 'usage-limit', accountId));
        }
        expect(await repo.recordOutcome(roomy, 'failed', T0, undefined, limitOf(narrow, 'usage-limit', accountId))).toMatchObject({
          excluded: false,
        });
      });
    });

    it('lets the budget refill once the earlier exclusions are older than the window', async () => {
      const slug = await project(ACCOUNT_A);
      const runnerId = await runner(ACCOUNT_A, [slug]);
      await pauseRunner(runnerId, '2026-11-10T12:00:00.000Z');
      const repo = new TeamStateRepo(env.DB);
      for (let i = 0; i < RUNNER_EXCLUSION_BUDGET; i += 1) {
        await repo.recordOutcome(slug, 'failed', T0, undefined, limitOf(runnerId, 'usage-limit'));
      }
      const later = new Date(Date.parse(T0) + RUNNER_EXCLUSION_WINDOW_MS + 1000).toISOString();
      expect(await repo.recordOutcome(slug, 'failed', later, undefined, limitOf(runnerId, 'usage-limit'))).toMatchObject({ excluded: true });
    });

    it('takes a pause that lapsed inside the grace window, not one older, another runner’s, or one in another account', async () => {
      const slug = await project(ACCOUNT_A);
      const repo = new TeamStateRepo(env.DB);
      // T1 is five minutes after T0: a minute's lapse is inside the grace window, ten minutes' is not.
      const lapsedJustNow = await runner(ACCOUNT_A, [slug]);
      await pauseRunner(lapsedJustNow, '2026-11-10T10:04:00.000Z');
      expect(await repo.recordOutcome(slug, 'failed', T1, undefined, limitOf(lapsedJustNow, 'usage-limit'))).toMatchObject({ excluded: true });

      const lapsedLongAgo = await runner(ACCOUNT_A, [slug]);
      await pauseRunner(lapsedLongAgo, '2026-11-10T09:55:00.000Z');
      expect(await repo.recordOutcome(slug, 'failed', T1, undefined, limitOf(lapsedLongAgo, 'usage-limit'))).toEqual({
        failedStreak: 1,
        paused: false,
        excluded: false,
      });

      // The pause belongs to the finishing runner, in its own account: someone else's pause backs nothing.
      const unpaused = await runner(ACCOUNT_A, [slug]);
      const otherAccount = await runner(ACCOUNT_B, []);
      await pauseRunner(otherAccount, PAUSED_UNTIL);
      expect(await repo.recordOutcome(slug, 'failed', T1, undefined, limitOf(unpaused, 'rate-limit'))).toMatchObject({ failedStreak: 2, excluded: false });
      expect(await repo.recordOutcome(slug, 'failed', T1, undefined, limitOf(otherAccount, 'rate-limit', ACCOUNT_A))).toMatchObject({
        failedStreak: 3,
        excluded: false,
      });
      expect(await excludedCount(lapsedLongAgo)).toBe(0);
      expect(await excludedCount(otherAccount)).toBe(0);
    });
  });

  it('cancels a runner’s live jobs outside a narrowed allow-list', async () => {
    const kept = await project(ACCOUNT_A);
    const lost = await project(ACCOUNT_A);
    const r = await runner(ACCOUNT_A, [kept, lost]);
    const id = await enqueue(lost);
    await claimAs(r, { tokenHash: '7'.repeat(64) });
    await new RunnersRepo(env.DB).setScope(ACCOUNT_A, r, { projectScope: 'selected', allowedProjects: [kept] }, 'owner', audit('runner.scope-changed'), jobs.cancelUnservedStatements(r, T1));
    expect(await jobs.findById(id)).toMatchObject({ state: 'cancelled', result: { reason: 'runner-allow-list' } });
  });

  // R-SCOPE-5: `all → selected` is a narrowing like any other; the cancel rides in the same batch.
  it('cancels a runner’s live jobs outside the list when its scope goes from all to selected', async () => {
    const kept = await project(ACCOUNT_A);
    const lost = await project(ACCOUNT_A);
    const r = await runner(ACCOUNT_A, 'all');
    const id = await enqueue(lost, ACCOUNT_A, { priority: URGENT });
    expect(((await claimAs(r, { tokenHash: tok(60) })) as { id: string }).id).toBe(id);
    const runners = new RunnersRepo(env.DB);
    const narrowed = { projectScope: 'selected' as const, allowedProjects: [kept] };
    expect(await runners.setScope(ACCOUNT_A, r, narrowed, 'owner', { ...audit('runner.scope-changed'), target: r }, jobs.cancelUnservedStatements(r, T1))).toBe('changed');
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
    const same = { ...audit('runner.scope-changed'), target: r };
    expect(await runners.setScope(ACCOUNT_A, r, { projectScope: 'selected', allowedProjects: [kept] }, 'owner', same, jobs.cancelUnservedStatements(r, T1))).toBe('unchanged');
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

// #612: review jobs are enqueued per role in one batch, with their parent; a live dedupe key refuses the batch.
describe('JobsRepo.enqueueAll', () => {
  const HEAD = 'a'.repeat(40);
  const review = (slug: string, role: string, parentJobId: string): NewJob => ({
    id: ulid('RV'),
    accountId: ACCOUNT_A,
    projectSlug: slug,
    kind: 'review',
    role,
    payload: { pr: 7, head_sha: HEAD, role },
    priority: 1,
    requestedBy: 'orchestrator',
    dedupeKey: `${slug}:review:7:${HEAD}:${role}`,
    needsLocal: false,
    maxMinutes: 90,
    at: T0,
    parentJobId,
  });
  const entry = (job: NewJob) => ({ job, audit: { ...audit('job.dispatched'), target: job.id } });

  it('writes every job with its parent and one audit row each', async () => {
    const slug = await project(ACCOUNT_A);
    const parent = await enqueue(slug);
    const qa = review(slug, 'qa', parent);
    const security = review(slug, 'security', parent);
    expect(await jobs.enqueueAll([entry(qa), entry(security)])).toBe('ok');
    expect((await jobs.findById(qa.id))?.parentJobId).toBe(parent);
    expect((await jobs.findById(security.id))?.parentJobId).toBe(parent);
    const audits = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE target IN (?1, ?2)`)
      .bind(qa.id, security.id)
      .first<{ n: number }>();
    expect(audits?.n).toBe(2);
    const live = await jobs.findLiveByDedupeKeys(slug, [qa.dedupeKey ?? '', `${slug}:review:7:${HEAD}:reviewer`]);
    expect(live.map((job) => job.id)).toEqual([qa.id]);
  });

  it('writes none of the batch when one dedupe key is live', async () => {
    const slug = await project(ACCOUNT_A);
    const parent = await enqueue(slug);
    expect(await jobs.enqueueAll([entry(review(slug, 'qa', parent))])).toBe('ok');
    const reviewer = review(slug, 'reviewer', parent);
    const repeat = review(slug, 'qa', parent);
    expect(await jobs.enqueueAll([entry(reviewer), entry(repeat)])).toBe('job-exists');
    expect(await jobs.findById(reviewer.id)).toBeNull();
    expect(await jobs.findById(repeat.id)).toBeNull();
  });

  // #580: the route suite covers a holding job; here, a hold that names no live job.
  it('writes none of the batch when the hold names no live job', async () => {
    const slug = await project(ACCOUNT_A);
    const parent = await enqueue(slug);
    const qa = review(slug, 'qa', parent);
    const hold = { tokenHash: 'f'.repeat(64), jobId: parent, at: T0 };
    // The NULL account trips the account trigger before NOT NULL; either way the batch fails as a whole.
    await expect(jobs.enqueueAll([entry(qa)], hold)).rejects.toThrow(/jobs\.account_id/);
    expect(await jobs.findById(qa.id)).toBeNull();
    const audits = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE target = ?1`).bind(qa.id).first<{ n: number }>();
    expect(audits?.n).toBe(0);
  });

  it('refuses a parent that is not a job (the foreign key), writing nothing', async () => {
    const slug = await project(ACCOUNT_A);
    const orphan = review(slug, 'qa', ulid('NP'));
    await expect(jobs.enqueueAll([entry(orphan)])).rejects.toThrow();
    expect(await jobs.findById(orphan.id)).toBeNull();
  });

  it('writes nothing for an empty batch', async () => {
    expect(await jobs.enqueueAll([])).toBe('ok');
  });
});

// #775 (R-RUN): the jobs tile's `runnerAvailability` reads the claim's own terms, so it never says `ready` for a Run
// now no runner could claim, and says `ready` whenever an online runner would claim it. Each case is its own account,
// so an `all` runner of one case never serves another's project.
describe('RunnersRepo.availabilityOf agrees with the claim', () => {
  const runners = new RunnersRepo(env.DB);
  const SILENT = '2026-11-10T09:50:00.000Z';
  let accounts = 0;
  let tokens = 0;

  interface Case {
    readonly accountId: string;
    readonly slug: string;
    /** The runners of the case and whether each is online at T1. */
    readonly runners: readonly { readonly id: string; readonly isOnline: boolean }[];
  }

  async function account(): Promise<string> {
    accounts += 1;
    const id = `01M6YSNJ00000000000000AV${String(accounts).padStart(2, '0')}`;
    await env.DB.prepare(`INSERT INTO accounts (id, slug, name, entitlements, created_at) VALUES (?1, ?2, 'AV', '{"max_concurrency":32}', ?3)`).bind(id, `jb-av-${String(accounts)}`, T0).run();
    return id;
  }

  async function seen(id: string, lastSeenAt: string | null): Promise<{ id: string; isOnline: boolean }> {
    await env.DB.prepare(`UPDATE runners SET last_seen_at = ?2 WHERE id = ?1`).bind(id, lastSeenAt).run();
    return { id, isOnline: lastSeenAt === T1 };
  }

  /** Every runner of the case tries to claim the case's queued job; `true` when an online one took it. */
  async function onlineRunnerClaims(c: Case): Promise<boolean> {
    let isClaimed = false;
    for (const r of c.runners.filter((candidate) => candidate.isOnline)) {
      tokens += 1;
      const job = await claimAs(r.id, { accountId: c.accountId, tokenHash: `a7a11${tokens.toString(16)}`.padEnd(64, '0') });
      isClaimed ||= job !== null;
    }
    return isClaimed;
  }

  const cases: readonly (readonly [string, 'ready' | 'paused' | 'offline' | 'none', () => Promise<Case>])[] = [
    ['no runner at all', 'none', async () => {
      const accountId = await account();
      return { accountId, slug: await project(accountId), runners: [] };
    }],
    ['a selected runner that does not list the project', 'none', async () => {
      const accountId = await account();
      const slug = await project(accountId);
      return { accountId, slug, runners: [await seen(await runner(accountId, ['elsewhere']), T1)] };
    }],
    ['a selected runner that lists it, online', 'ready', async () => {
      const accountId = await account();
      const slug = await project(accountId);
      return { accountId, slug, runners: [await seen(await runner(accountId, [slug]), T1)] };
    }],
    ['an all runner, online', 'ready', async () => {
      const accountId = await account();
      const slug = await project(accountId);
      return { accountId, slug, runners: [await seen(await runner(accountId, 'all'), T1)] };
    }],
    ['the only eligible runner silent past the online window', 'offline', async () => {
      const accountId = await account();
      const slug = await project(accountId);
      return { accountId, slug, runners: [await seen(await runner(accountId, [slug]), SILENT)] };
    }],
    ['the only eligible runner never seen', 'offline', async () => {
      const accountId = await account();
      const slug = await project(accountId);
      return { accountId, slug, runners: [await seen(await runner(accountId, [slug]), null)] };
    }],
    ['the only eligible runner online but paused', 'paused', async () => {
      const accountId = await account();
      const slug = await project(accountId);
      const r = await seen(await runner(accountId, [slug]), T1);
      await env.DB.prepare(`UPDATE runners SET paused_until = '2026-11-10T12:00:00.000Z', pause_reason = 'usage-limit' WHERE id = ?1`).bind(r.id).run();
      return { accountId, slug, runners: [r] };
    }],
    ['a pause that has already ended', 'ready', async () => {
      const accountId = await account();
      const slug = await project(accountId);
      const r = await seen(await runner(accountId, [slug]), T1);
      await env.DB.prepare(`UPDATE runners SET paused_until = ?2, pause_reason = 'rate-limit' WHERE id = ?1`).bind(r.id, T0).run();
      return { accountId, slug, runners: [r] };
    }],
    ['a revoked runner', 'none', async () => {
      const accountId = await account();
      const slug = await project(accountId);
      const r = await seen(await runner(accountId, [slug]), T1);
      await env.DB.prepare(`UPDATE runners SET revoked_at = ?2 WHERE id = ?1`).bind(r.id, T0).run();
      return { accountId, slug, runners: [r] };
    }],
    ['an all runner of another account', 'none', async () => {
      const accountId = await account();
      const other = await account();
      const slug = await project(accountId);
      await seen(await runner(other, 'all'), T1);
      return { accountId, slug, runners: [] };
    }],
    ['a project pinned to another runner, which is silent', 'offline', async () => {
      const accountId = await account();
      const pinned = await seen(await runner(accountId, 'all'), SILENT);
      const slug = await project(accountId, JSON.stringify({ mode: 'pinned', runner: pinned.id }));
      return { accountId, slug, runners: [pinned, await seen(await runner(accountId, 'all'), T1)] };
    }],
    // `policyAdmitsRunnerSql` alone would admit the fallback here; the claim waits out `offline_after_seconds`.
    ['failover: the preferred silent for less than offline_after_seconds, the fallback online', 'offline', async () => {
      const accountId = await account();
      const preferred = await seen(await runner(accountId, 'all'), SILENT);
      const fallback = await seen(await runner(accountId, 'all'), T1);
      const policy = { mode: 'failover', preferred: preferred.id, fallback: [fallback.id], offline_after_seconds: 3600 };
      return { accountId, slug: await project(accountId, JSON.stringify(policy)), runners: [preferred, fallback] };
    }],
    ['failover: the preferred silent past offline_after_seconds, the fallback online', 'ready', async () => {
      const accountId = await account();
      const preferred = await seen(await runner(accountId, 'all'), SILENT);
      const fallback = await seen(await runner(accountId, 'all'), T1);
      const policy = { mode: 'failover', preferred: preferred.id, fallback: [fallback.id], offline_after_seconds: 60 };
      return { accountId, slug: await project(accountId, JSON.stringify(policy)), runners: [preferred, fallback] };
    }],
    ['a runner declaring only api_key on a subscription project', 'none', async () => {
      const accountId = await account();
      const slug = await projectBy(accountId, null, 'subscription');
      return { accountId, slug, runners: [await seen(await runner(accountId, 'all', null, 8, { accessSources: ['api_key'] }), T1)] };
    }],
    ['a hosted runner on a subscription project (C12 row 6)', 'none', async () => {
      const accountId = await account();
      const slug = await projectBy(accountId, null, 'subscription');
      const r = await seen(await runner(accountId, [slug], null, 8, { hosted: true }), T1);
      return { accountId, slug, runners: [r] };
    }],
    ['a hosted runner on an api_key project', 'ready', async () => {
      const accountId = await account();
      const slug = await projectBy(accountId, null, 'api_key');
      const r = await seen(await runner(accountId, [slug], null, 8, { hosted: true }), T1);
      return { accountId, slug, runners: [r] };
    }],
    ['D3: two owners, a subscription all runner, another owner’s project', 'none', async () => {
      const accountId = await account();
      await owners(accountId, 2);
      const slug = await projectBy(accountId, 'owner-2');
      return { accountId, slug, runners: [await seen(await runner(accountId, 'all', null, 8, { enrolledBy: 'owner-1', accessSources: ['subscription'] }), T1)] };
    }],
    ['D3: two owners, a subscription all runner, its enroller’s project', 'ready', async () => {
      const accountId = await account();
      await owners(accountId, 2);
      const slug = await projectBy(accountId, 'owner-1');
      return { accountId, slug, runners: [await seen(await runner(accountId, 'all', null, 8, { enrolledBy: 'owner-1', accessSources: ['subscription'] }), T1)] };
    }],
    ['a suspended account', 'none', async () => {
      const accountId = await account();
      const slug = await project(accountId);
      const r = await seen(await runner(accountId, [slug]), T1);
      await env.DB.prepare(`UPDATE accounts SET suspended_at = ?2 WHERE id = ?1`).bind(accountId, T0).run();
      return { accountId, slug, runners: [r] };
    }],
    ['an archived project', 'none', async () => {
      const accountId = await account();
      const slug = await project(accountId);
      const r = await seen(await runner(accountId, [slug]), T1);
      await env.DB.prepare(`UPDATE projects SET archived_at = ?2 WHERE slug = ?1`).bind(slug, T0).run();
      return { accountId, slug, runners: [r] };
    }],
  ];

  it.each(cases)('%s: %s', async (_name, expected, seed) => {
    const c = await seed();
    const availability = await runners.availabilityOf(c.slug, T1);
    expect(availability).toBe(expected);
    await enqueue(c.slug, c.accountId, { priority: URGENT });
    // `ready` exactly when an online runner claims it; a silent runner does not poll, so its claim is not asked.
    expect(await onlineRunnerClaims(c)).toBe(availability === 'ready');
  });

  it('an Actions project needs no runner: ready while live, none when archived', async () => {
    const accountId = await account();
    const slug = await projectBy(accountId, null, 'api_key');
    await env.DB.prepare(`UPDATE projects SET dispatch = 'actions' WHERE slug = ?1`).bind(slug).run();
    expect(await runners.availabilityOf(slug, T1)).toBe('ready');
    await env.DB.prepare(`UPDATE projects SET archived_at = ?2 WHERE slug = ?1`).bind(slug, T0).run();
    expect(await runners.availabilityOf(slug, T1)).toBe('none');
  });

  it('an actions-ephemeral identity is no runner for a Run now', async () => {
    const accountId = await account();
    const slug = await projectBy(accountId, null, 'api_key');
    await seen(await runner(accountId, [slug], null, 8, { isolation: 'actions-ephemeral' }), T1);
    expect(await runners.availabilityOf(slug, T1)).toBe('none');
  });

  // SECURITY review of #804: the owner's reason for `none`, from the same terms with one turned around.
  it.each([
    ['no runner at all', 'no-runner', async (accountId: string) => project(accountId)],
    ['a runner whose access sources do not fit', 'access-mismatch', async (accountId: string) => {
      const slug = await projectBy(accountId, null, 'subscription');
      await seen(await runner(accountId, 'all', null, 8, { accessSources: ['api_key'] }), T1);
      return slug;
    }],
    ['a hosted runner on a subscription project', 'access-mismatch', async (accountId: string) => {
      const slug = await projectBy(accountId, null, 'subscription');
      await seen(await runner(accountId, [slug], null, 8, { hosted: true }), T1);
      return slug;
    }],
    ['D3 holding back the only subscription runner', 'other-owner-subscription', async (accountId: string) => {
      await owners(accountId, 2);
      const slug = await projectBy(accountId, 'owner-2');
      await seen(await runner(accountId, 'all', null, 8, { enrolledBy: 'owner-1', accessSources: ['subscription'] }), T1);
      return slug;
    }],
    ['D3 runner pinned away from the project', 'no-runner', async (accountId: string) => {
      await owners(accountId, 2);
      const elsewhere = await runner(accountId, 'all', null, 8, { enrolledBy: 'owner-1' });
      const d3 = await runner(accountId, 'all', null, 8, { enrolledBy: 'owner-1', accessSources: ['subscription'] });
      const slug = await projectBy(accountId, 'owner-2');
      await env.DB.prepare(`UPDATE projects SET runner_policy = ?2 WHERE slug = ?1`).bind(slug, JSON.stringify({ mode: 'pinned', runner: elsewhere })).run();
      await env.DB.prepare(`UPDATE runners SET revoked_at = ?2 WHERE id = ?1`).bind(elsewhere, T0).run();
      expect(d3).not.toBe(elsewhere);
      return slug;
    }],
  ] as const)('none because of %s: %s', async (_name, reason, seed) => {
    const accountId = await account();
    const slug = await seed(accountId);
    expect(await runners.availabilityOf(slug, T1)).toBe('none');
    expect(await runners.unavailableReasonOf(slug, T1)).toBe(reason);
  });

  it('is none for a project that does not exist', async () => {
    expect(await runners.availabilityOf('no-such-project', T1)).toBe('none');
  });
});
