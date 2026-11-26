import { env } from 'cloudflare:test';
import { TEAM_CONFIG_SCHEMA } from '@shared/contracts';
import type { NewAuditEvent } from '../accounts/audit.repo';
import {
  entitledConcurrencyAdmittedSql,
  entitledConcurrencyOf,
  entitledConcurrencyParams,
} from '../team-config/claim-admission';
import { TeamConfigRepo } from '../team-config/team-config.repo';
import { JobsRepo, type JobRecord } from './jobs.repo';

// #746 (ADR 0008 decision 6): the account's entitled `maxConcurrency` at the pull claim and the Actions dispatch,
// counted inside the write that hands a job out, directly against D1. Every case has an account of its own, since
// the count is account-wide.

const T0 = '2026-11-17T10:00:00.000Z';
const T1 = '2026-11-17T10:05:00.000Z';
const LEASE = '2026-11-17T10:30:00.000Z';

const jobs = new JobsRepo(env.DB);
const configs = new TeamConfigRepo(env.DB);

let counter = 0;
const ulid = (tag: string): string => {
  counter += 1;
  return `01M6YSNJ00000000000${tag}${String(counter).padStart(5, '0')}`.slice(0, 26);
};

const auditOf = (
  accountId: string,
  kind: NewAuditEvent['kind'],
  target: string | null = null,
): NewAuditEvent => ({
  accountId,
  at: T0,
  actorKind: 'system',
  actor: 'spec',
  kind,
  target,
});

/** An account on `plan` with the operator's override `entitlements` (the raw JSON the column holds). */
async function account(plan: 'free' | 'team' = 'free', entitlements = '{}'): Promise<string> {
  const id = ulid('EC');
  await env.DB.prepare(
    `INSERT INTO accounts (id, slug, name, plan, entitlements, created_at) VALUES (?1, ?2, 'E', ?3, ?4, ?5)`,
  )
    .bind(id, `ec-${String(counter)}`, plan, entitlements, T0)
    .run();
  return id;
}

/** A project of the account on an API key (so the Actions admission can pass), dispatched by `dispatch`. */
async function project(accountId: string, dispatch: 'pull' | 'actions' = 'pull'): Promise<string> {
  counter += 1;
  const slug = `ec-${String(counter)}`;
  await env.DB.prepare(
    `INSERT INTO projects (slug, repo, display_name, cache_epoch, added_at, account_id) VALUES (?1, ?2, ?1, 0, ?3, ?4)`,
  )
    .bind(slug, `acme/${slug}`, T0, accountId)
    .run();
  const saved = await configs.save({
    projectSlug: slug,
    expectedRevision: 0,
    config: { schema: TEAM_CONFIG_SCHEMA, access: { source: 'api_key' } },
    diff: [{ path: 'access.source' }],
    reason: null,
    id: ulid('RV'),
    at: T0,
    by: 'owner',
    audit: { ...auditOf(accountId, 'team-config.changed', slug), actorKind: 'user', actor: 'owner' },
  });
  expect(saved.kind).toBe('saved');
  if (dispatch === 'actions') {
    await env.DB.prepare(`UPDATE projects SET dispatch = 'actions' WHERE slug = ?1`).bind(slug).run();
  }
  return slug;
}

/** A local runner of the account; its own `maxConcurrency` is high, so only the account's entitlement limits it. */
async function runner(accountId: string, allowed: readonly string[]): Promise<string> {
  const id = ulid('RN');
  await env.DB.prepare(
    `INSERT INTO runners (id, account_id, name, public_key_jwk, capabilities, isolation, allowed_projects, version, enrolled_at)
     VALUES (?1, ?2, 'r', ?3, '{"local":true,"maxConcurrency":8}', 'user', ?4, '0.1.0', ?5)`,
  )
    .bind(
      id,
      accountId,
      JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: 'x'.repeat(43) }),
      JSON.stringify(allowed),
      T0,
    )
    .run();
  return id;
}

async function enqueue(accountId: string, slug: string, role = 'dev'): Promise<string> {
  const id = ulid('JB');
  const outcome = await jobs.enqueue(
    {
      id,
      accountId,
      projectSlug: slug,
      kind: 'slot-dev',
      role,
      payload: {},
      priority: 0,
      requestedBy: 'owner',
      dedupeKey: null,
      needsLocal: false,
      maxMinutes: 90,
      at: T0,
    },
    auditOf(accountId, 'job.dispatched', slug),
  );
  expect(outcome).toBe('ok');
  return id;
}

let token = 0;
const claimAs = (accountId: string, runnerId: string): Promise<JobRecord | null> => {
  token += 1;
  return jobs.claim({
    runnerId,
    accountId,
    local: true,
    tokenHash: `ec${token.toString(16)}`.padEnd(64, '0'),
    now: T1,
    leaseUntil: LEASE,
  });
};

async function finish(accountId: string, job: JobRecord | null, runnerId: string): Promise<void> {
  expect(
    await jobs.finish(
      job?.id ?? '',
      runnerId,
      { result: 'finished', summary: 's', metrics: {}, acted: false },
      T1,
      {
        ...auditOf(accountId, 'job.finished', job?.id ?? null),
      },
    ),
  ).toBe(true);
}

describe('the pull claim holds the account to its entitled concurrency (#746)', () => {
  it('free tier, two runners: the second claim gets nothing until the first job ends', async () => {
    const acct = await account();
    const slug = await project(acct);
    const mac = await runner(acct, [slug]);
    const vps = await runner(acct, [slug]);
    await enqueue(acct, slug);
    const second = await enqueue(acct, slug);

    const first = await claimAs(acct, mac);
    expect(first).not.toBeNull();
    expect(await claimAs(acct, vps)).toBeNull();
    expect(await jobs.findById(second)).toMatchObject({ state: 'queued', runnerId: null });

    await finish(acct, first, mac);
    expect((await claimAs(acct, vps))?.id).toBe(second);
  });

  it('counts every project of the account, and never another account’s jobs', async () => {
    const acct = await account();
    const other = await account();
    const one = await project(acct);
    const two = await project(acct);
    const theirs = await project(other);
    const mine = await runner(acct, [one, two]);
    const their = await runner(other, [theirs]);
    await enqueue(acct, one);
    await enqueue(acct, two);
    await enqueue(other, theirs);

    expect((await claimAs(acct, mine))?.projectSlug).toBe(one);
    expect(await claimAs(acct, mine)).toBeNull();
    expect((await claimAs(other, their))?.projectSlug).toBe(theirs);
  });

  it('a running job counts as a claimed one does', async () => {
    const acct = await account();
    const slug = await project(acct);
    const mac = await runner(acct, [slug]);
    await enqueue(acct, slug);
    await enqueue(acct, slug);
    const first = await claimAs(acct, mac);
    expect(
      await jobs.appendEvents(first?.id ?? '', mac, [{ level: 'info', kind: 'started', payload: {} }], T1),
    ).toMatchObject({
      held: true,
    });
    expect((await jobs.findById(first?.id ?? ''))?.state).toBe('running');
    expect(await claimAs(acct, mac)).toBeNull();
  });

  it('the team plan claims three at once; the operator’s override raises or lowers it', async () => {
    const team = await account('team');
    const slug = await project(team);
    const mac = await runner(team, [slug]);
    for (let n = 0; n < 4; n += 1) {
      await enqueue(team, slug);
    }
    expect(await claimAs(team, mac)).not.toBeNull();
    expect(await claimAs(team, mac)).not.toBeNull();
    expect(await claimAs(team, mac)).not.toBeNull();
    expect(await claimAs(team, mac)).toBeNull();

    const raised = await account('free', '{"max_concurrency":2}');
    const raisedSlug = await project(raised);
    const raisedRunner = await runner(raised, [raisedSlug]);
    for (let n = 0; n < 3; n += 1) {
      await enqueue(raised, raisedSlug);
    }
    expect(await claimAs(raised, raisedRunner)).not.toBeNull();
    expect(await claimAs(raised, raisedRunner)).not.toBeNull();
    expect(await claimAs(raised, raisedRunner)).toBeNull();

    // An override the guard refuses (past its bound) fails closed to the free tier, never wider.
    const broken = await account('team', '{"max_concurrency":99}');
    const brokenSlug = await project(broken);
    const brokenRunner = await runner(broken, [brokenSlug]);
    await enqueue(broken, brokenSlug);
    await enqueue(broken, brokenSlug);
    expect(await claimAs(broken, brokenRunner)).not.toBeNull();
    expect(await claimAs(broken, brokenRunner)).toBeNull();
  });

  it('max_concurrency 0 claims nothing, and lifting it lets the job through', async () => {
    const acct = await account('team', '{"max_concurrency":0}');
    const slug = await project(acct);
    const mac = await runner(acct, [slug]);
    const id = await enqueue(acct, slug);
    expect(await claimAs(acct, mac)).toBeNull();
    expect(await jobs.findById(id)).toMatchObject({ state: 'queued', runnerId: null });

    await env.DB.prepare(`UPDATE accounts SET entitlements = '{}' WHERE id = ?1`).bind(acct).run();
    expect((await claimAs(acct, mac))?.id).toBe(id);
  });

  it('two claims at once for the account’s last slot: one wins, the other gets nothing', async () => {
    const acct = await account();
    const slug = await project(acct);
    const mac = await runner(acct, [slug]);
    const vps = await runner(acct, [slug]);
    const ids = [await enqueue(acct, slug), await enqueue(acct, slug)];
    const both = await Promise.all([claimAs(acct, mac), claimAs(acct, vps)]);
    expect(both.filter((job) => job !== null)).toHaveLength(1);
    const states = await Promise.all(ids.map(async (id) => (await jobs.findById(id))?.state));
    expect(states.sort()).toEqual(['claimed', 'queued']);
  });
});

describe('the Actions dispatch uses the same admission (#746)', () => {
  it('a dispatched job no run has exchanged yet holds the slot against a pull claim', async () => {
    const acct = await account();
    const actions = await project(acct, 'actions');
    const pull = await project(acct);
    const mac = await runner(acct, [pull]);
    const dispatched = await enqueue(acct, actions);
    await enqueue(acct, pull);

    expect(await jobs.listDispatchable(T1, 10, { accountId: acct })).toEqual([dispatched]);
    expect(await jobs.markDispatched(dispatched, T1)).toBe(true);
    expect(await claimAs(acct, mac)).toBeNull();

    // A no-show ends it: the slot is free again.
    expect(await jobs.failUndispatched(dispatched, T1, 'actions-no-show', 'actions-no-show')).not.toBeNull();
    expect(await claimAs(acct, mac)).not.toBeNull();
  });

  it('a claimed pull job holds the slot against a dispatch, which waits undispatched until it ends', async () => {
    const acct = await account();
    const actions = await project(acct, 'actions');
    const pull = await project(acct);
    const mac = await runner(acct, [pull]);
    const waiting = await enqueue(acct, actions);
    await enqueue(acct, pull);
    const held = await claimAs(acct, mac);
    expect(held).not.toBeNull();

    expect((await jobs.findDispatchTarget(waiting, T1))?.admitted).toBe(false);
    expect(await jobs.listDispatchable(T1, 10, { accountId: acct })).toEqual([]);
    expect(await jobs.markDispatched(waiting, T1)).toBe(false);
    expect(await jobs.findById(waiting)).toMatchObject({ state: 'queued', runnerId: null });

    await finish(acct, held, mac);
    expect(await jobs.listDispatchable(T1, 10, { accountId: acct })).toEqual([waiting]);
    expect(await jobs.markDispatched(waiting, T1)).toBe(true);
  });

  it('of two dispatches racing for the account’s last slot, one writes', async () => {
    const acct = await account();
    const one = await project(acct, 'actions');
    const two = await project(acct, 'actions');
    const a = await enqueue(acct, one);
    const b = await enqueue(acct, two);
    const marks = await Promise.all([jobs.markDispatched(a, T1), jobs.markDispatched(b, T1)]);
    expect(marks.filter(Boolean)).toHaveLength(1);
  });

  it('max_concurrency 0 dispatches nothing', async () => {
    const acct = await account('team', '{"max_concurrency":0}');
    const slug = await project(acct, 'actions');
    const id = await enqueue(acct, slug);
    expect((await jobs.findDispatchTarget(id, T1))?.admitted).toBe(false);
    expect(await jobs.listDispatchable(T1, 10, {})).not.toContain(id);
    expect(await jobs.markDispatched(id, T1)).toBe(false);
  });

  it('the sweep’s listing reads each account’s own limit', async () => {
    const free = await account();
    const team = await account('team');
    const freeSlug = await project(free, 'actions');
    const teamSlug = await project(team, 'actions');
    const freeJobs = [await enqueue(free, freeSlug), await enqueue(free, freeSlug)];
    const teamJobs = [await enqueue(team, teamSlug), await enqueue(team, teamSlug)];
    expect(await jobs.markDispatched(freeJobs[0] ?? '', T1)).toBe(true);
    expect(await jobs.markDispatched(teamJobs[0] ?? '', T1)).toBe(true);
    const listed = await jobs.listDispatchable(T1, 100, {});
    expect(listed).not.toContain(freeJobs[1]);
    expect(listed).toContain(teamJobs[1]);
  });
});

describe('the entitled limit and its account-row guard (#746)', () => {
  it('reads entitlementsOf: the plan, the override on top, the free tier for anything it cannot trust', () => {
    expect(entitledConcurrencyOf({ plan: 'free', entitlements: '{}' }).limit).toBe(1);
    expect(entitledConcurrencyOf({ plan: 'team', entitlements: '{}' }).limit).toBe(3);
    expect(entitledConcurrencyOf({ plan: 'team', entitlements: '{"max_concurrency":0}' }).limit).toBe(0);
    expect(entitledConcurrencyOf({ plan: 'team', entitlements: '{"max_concurrency":33}' }).limit).toBe(1);
    expect(entitledConcurrencyOf({ plan: 'gold', entitlements: '{}' }).limit).toBe(1);
    expect(entitledConcurrencyOf({ plan: 'team', entitlements: 'not json' }).limit).toBe(1);
  });

  it('admits nothing when the account row changed after the limit was read', async () => {
    const acct = await account('team');
    const slug = await project(acct);
    const id = await enqueue(acct, slug);
    const admitted = async (
      entitled: ReturnType<typeof entitledConcurrencyOf>,
    ): Promise<number | undefined> =>
      (
        await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM jobs j JOIN accounts a ON a.id = j.account_id
           WHERE j.id = ?1 AND ${entitledConcurrencyAdmittedSql('?2', '?3', '?4')}`,
        )
          .bind(id, ...entitledConcurrencyParams(entitled))
          .first<{ n: number }>()
      )?.n;
    const before = entitledConcurrencyOf({ plan: 'team', entitlements: '{}' });
    expect(await admitted(before)).toBe(1);
    // The operator's change commits between the read and the write: the stale limit of 3 no longer holds.
    await env.DB.prepare(`UPDATE accounts SET entitlements = '{"max_concurrency":0}' WHERE id = ?1`)
      .bind(acct)
      .run();
    expect(await admitted(before)).toBe(0);
    expect(
      await admitted(entitledConcurrencyOf({ plan: 'team', entitlements: '{"max_concurrency":0}' })),
    ).toBe(0);
  });
});

describe('JobsRepo.concurrencyStopsOf (#746): the Needs-you row of max_concurrency 0', () => {
  it('names a project with queued jobs on an account entitled to none, and nothing else', async () => {
    const stopped = await account('team', '{"max_concurrency":0}');
    const running = await account();
    const waiting = await project(stopped);
    const idle = await project(stopped);
    const fine = await project(running);
    await enqueue(stopped, waiting);
    await enqueue(stopped, waiting);
    await enqueue(running, fine);
    expect(await jobs.concurrencyStopsOf([waiting, idle, fine])).toEqual([
      { projectSlug: waiting, queuedJobs: 2 },
    ]);
    expect(await jobs.concurrencyStopsOf([])).toEqual([]);
  });
});
