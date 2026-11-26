import { env } from 'cloudflare:test';
import { BUDGET_PAUSER, TEAM_CONFIG_SCHEMA, type TeamConfig } from '@shared/contracts';
import type { NewAuditEvent } from '../accounts/audit.repo';
import { JobsRepo, type FinishSpend, type JobRecord } from '../jobs/jobs.repo';
import { TeamStateRepo } from '../jobs/team-state.repo';
import { ProjectSpendRepo } from './project-spend.repo';
import { TeamConfigRepo, type TeamConfigWrite } from './team-config.repo';

// #684 (ADR 0009 d.6, threat model C12 row 5 / T6): the budget stop and the role admission of the Actions dispatch
// (#722, #716), directly against D1.

const ACCOUNT = '01M6YSNJ00000000000000BSA1';
const T0 = '2026-11-16T10:00:00.000Z';
const T1 = '2026-11-16T10:05:00.000Z';
const T2 = '2026-11-16T10:06:00.000Z';
const LEASE = '2026-11-16T10:30:00.000Z';
const DECEMBER = '2026-12-01T00:05:00.000Z';
const DECEMBER_LATER = '2026-12-01T00:10:00.000Z';
const DECEMBER_LEASE = '2026-12-01T00:30:00.000Z';

let counter = 0;
const ulid = (tag: string): string => {
  counter += 1;
  return `01M6YSNJ00000000000${tag}${String(counter).padStart(5, '0')}`.slice(0, 26);
};

const configs = new TeamConfigRepo(env.DB);
const jobs = new JobsRepo(env.DB);
const teamState = new TeamStateRepo(env.DB);
const spend = new ProjectSpendRepo(env.DB);

// The entitled concurrency (#746) is account-wide and these cases share the account: the top of the override's
// range keeps it out of the rules each case is about; the concurrency specs set their own.
beforeAll(async () => {
  await env.DB.prepare(
    `INSERT INTO accounts (id, slug, name, entitlements, created_at) VALUES (?1, 'bs-a', 'A', '{"max_concurrency":32}', ?2)`,
  )
    .bind(ACCOUNT, T0)
    .run();
});

const auditOf = (kind: NewAuditEvent['kind'], target: string): NewAuditEvent => ({
  accountId: ACCOUNT,
  at: T0,
  actorKind: 'system',
  actor: 'spec',
  kind,
  target,
});

const revisions = new Map<string, number>();

/** Saves `config` over the project's current revision, as the owner's PUT does. */
async function save(slug: string, config: Partial<TeamConfig>, at = T0): Promise<void> {
  const expected = revisions.get(slug) ?? 0;
  const write: TeamConfigWrite = {
    projectSlug: slug,
    expectedRevision: expected,
    config: { schema: TEAM_CONFIG_SCHEMA, ...config, access: { source: 'api_key' } },
    diff: [{ path: 'budget.monthly_usd' }],
    reason: null,
    id: ulid('RV'),
    at,
    by: 'owner',
    audit: { ...auditOf('team-config.changed', slug), actorKind: 'user', actor: 'owner', at },
  };
  expect((await configs.save(write)).kind).toBe('saved');
  revisions.set(slug, expected + 1);
}

async function project(config: Partial<TeamConfig> = {}): Promise<string> {
  counter += 1;
  const slug = `bs-${String(counter)}`;
  await env.DB.prepare(
    `INSERT INTO projects (slug, repo, display_name, cache_epoch, added_at, account_id) VALUES (?1, ?2, ?1, 0, ?3, ?4)`,
  )
    .bind(slug, `acme/${slug}`, T0, ACCOUNT)
    .run();
  await save(slug, config);
  return slug;
}

async function runner(allowed: readonly string[]): Promise<string> {
  const id = ulid('RN');
  await env.DB.prepare(
    `INSERT INTO runners (id, account_id, name, public_key_jwk, capabilities, isolation, allowed_projects, version, enrolled_at)
     VALUES (?1, ?2, 'r', ?3, '{"local":true,"maxConcurrency":8}', 'user', ?4, '0.1.0', ?5)`,
  )
    .bind(
      id,
      ACCOUNT,
      JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: 'x'.repeat(43) }),
      JSON.stringify(allowed),
      T0,
    )
    .run();
  return id;
}

async function enqueue(slug: string, role = 'dev', priority = 0): Promise<string> {
  const id = ulid('JB');
  expect(
    await jobs.enqueue(
      {
        id,
        accountId: ACCOUNT,
        projectSlug: slug,
        kind: 'slot-dev',
        role,
        payload: {},
        priority,
        requestedBy: 'owner',
        dedupeKey: null,
        needsLocal: false,
        maxMinutes: 90,
        at: T0,
      },
      auditOf('job.dispatched', slug),
    ),
  ).toBe('ok');
  return id;
}

let token = 0;
const claimAs = (runnerId: string, now = T1, leaseUntil = LEASE): Promise<JobRecord | null> => {
  token += 1;
  return jobs.claim({
    runnerId,
    accountId: ACCOUNT,
    local: true,
    tokenHash: token.toString(16).padStart(64, '0'),
    now,
    leaseUntil,
  });
};

const spent = (costUsd: number, slug: string): FinishSpend => ({
  costUsd,
  pauseAudit: auditOf('team.paused', slug),
});

/** Claims one queued job of the project and finishes it at `now`, reporting `costUsd`. */
async function runOne(slug: string, mac: string, costUsd: number, now = T2): Promise<string> {
  const job = await claimAs(mac);
  expect(job?.projectSlug).toBe(slug);
  const id = job?.id ?? '';
  const outcome = {
    result: 'finished' as const,
    summary: 's',
    metrics: { total_cost_usd: costUsd },
    acted: false,
  };
  expect(await jobs.finish(id, mac, outcome, now, auditOf('job.finished', id), spent(costUsd, slug))).toBe(
    true,
  );
  return id;
}

async function count(sql: string, ...params: unknown[]): Promise<number> {
  return (
    (
      await env.DB.prepare(sql)
        .bind(...params)
        .first<{ n: number }>()
    )?.n ?? 0
  );
}

const budgetPausesOf = (slug: string): Promise<number> =>
  count(`SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'team.paused' AND target = ?1`, slug);
const resumesOf = (slug: string): Promise<number> =>
  count(`SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'team.resumed' AND target = ?1`, slug);
const resumeThisMonth = (slug: string, at: string) =>
  teamState.resumeThisMonth(
    slug,
    at,
    { ...auditOf('team.resumed', slug), at },
    { ...auditOf('team.budget-waived', slug), at },
  );
async function waivedAtOf(slug: string, month: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT waived_at FROM project_spend WHERE project_slug = ?1 AND month = ?2`,
  )
    .bind(slug, month)
    .first<{ waived_at: string | null }>();
  return row?.waived_at ?? null;
}

describe('finish reconciles project_spend', () => {
  it('adds the cost to the UTC month of the finish, once: a replay or a second finish adds nothing', async () => {
    const slug = await project();
    const mac = await runner([slug]);
    await enqueue(slug);
    const id = await runOne(slug, mac, 1.25);
    expect(await spend.findMonth(slug, '2026-11')).toMatchObject({ spentUsd: 1.25, jobs: 1 });

    const outcome = {
      result: 'finished' as const,
      summary: 's',
      metrics: { total_cost_usd: 1.25 },
      acted: false,
    };
    // The same instant as the first finish: the transition takes nothing, so `changes()` guards the add.
    expect(await jobs.finish(id, mac, outcome, T2, auditOf('job.finished', id), spent(1.25, slug))).toBe(
      false,
    );
    expect(
      await jobs.finish(
        id,
        mac,
        outcome,
        '2026-11-16T10:07:00.000Z',
        auditOf('job.finished', id),
        spent(1.25, slug),
      ),
    ).toBe(false);
    expect(await spend.findMonth(slug, '2026-11')).toMatchObject({ spentUsd: 1.25, jobs: 1 });
  });

  it('records spend without a budget and never pauses on it', async () => {
    const slug = await project();
    const mac = await runner([slug]);
    await enqueue(slug);
    await runOne(slug, mac, 5000);
    expect((await spend.findMonth(slug, '2026-11')).spentUsd).toBe(5000);
    expect((await teamState.get(slug)).pausedBy).toBeNull();
  });
});

describe('the budget stop', () => {
  it('pauses the team by system:budget once the month reaches the budget, with one team.paused row', async () => {
    const slug = await project({ budget: { monthly_usd: 10 } });
    const mac = await runner([slug]);
    await enqueue(slug);
    await enqueue(slug);
    await runOne(slug, mac, 6);
    expect((await teamState.get(slug)).pausedBy).toBeNull();
    await runOne(slug, mac, 4);
    const state = await teamState.get(slug);
    expect(state).toMatchObject({ pausedBy: BUDGET_PAUSER, pausedAt: T2 });
    expect(await budgetPausesOf(slug)).toBe(1);
    expect(await teamState.budgetStopsOf([slug], T2)).toEqual([
      { projectSlug: slug, stoppedAt: T2, month: '2026-11', spentUsd: 10, budgetUsd: 10 },
    ]);
    await enqueue(slug);
    expect(await claimAs(mac)).toBeNull();
  });

  it('N parallel finishes past the cap give one pause, one Needs-you row and no further claim', async () => {
    const slug = await project({ budget: { monthly_usd: 3 }, roles: { dev: { max_parallel: 5 } } });
    const mac = await runner([slug]);
    const held: JobRecord[] = [];
    for (let n = 0; n < 4; n += 1) {
      await enqueue(slug);
      const job = await claimAs(mac);
      expect(job).not.toBeNull();
      if (job !== null) {
        held.push(job);
      }
    }
    const outcome = {
      result: 'finished' as const,
      summary: 's',
      metrics: { total_cost_usd: 2 },
      acted: false,
    };
    const finished = await Promise.all(
      held.map(async (job) =>
        jobs.finish(job.id, mac, outcome, T2, auditOf('job.finished', job.id), spent(2, slug)),
      ),
    );
    expect(finished).toEqual([true, true, true, true]);
    expect((await spend.findMonth(slug, '2026-11')).spentUsd).toBe(8);
    expect(await budgetPausesOf(slug)).toBe(1);
    expect(await teamState.budgetStopsOf([slug], T2)).toHaveLength(1);
    await enqueue(slug);
    expect(await claimAs(mac)).toBeNull();
  });

  it('keeps an owner’s pause when the cap is crossed, and still shows the budget row beside it', async () => {
    const slug = await project({ budget: { monthly_usd: 1 } });
    const mac = await runner([slug]);
    await enqueue(slug);
    const job = await claimAs(mac);
    expect(await teamState.pause(slug, 'owner', T1, auditOf('team.paused', slug))).toBe(true);
    const outcome = { result: 'failed' as const, summary: 's', metrics: { total_cost_usd: 1 }, acted: false };
    expect(
      await jobs.finish(job?.id ?? '', mac, outcome, T2, auditOf('job.finished', slug), spent(1, slug)),
    ).toBe(true);
    expect(await teamState.get(slug)).toMatchObject({ pausedBy: 'owner', pausedAt: T1 });
    expect(await budgetPausesOf(slug)).toBe(1);
    expect(await teamState.budgetStopsOf([slug], T2)).toEqual([
      { projectSlug: slug, stoppedAt: null, month: '2026-11', spentUsd: 1, budgetUsd: 1 },
    ]);
  });

  it('a save never lifts or replaces an owner’s pause, raising or lowering the budget', async () => {
    const slug = await project({ budget: { monthly_usd: 1 } });
    const mac = await runner([slug]);
    await enqueue(slug);
    const job = await claimAs(mac);
    expect(await teamState.pause(slug, 'owner', T1, auditOf('team.paused', slug))).toBe(true);
    const outcome = {
      result: 'finished' as const,
      summary: 's',
      metrics: { total_cost_usd: 1.5 },
      acted: false,
    };
    await jobs.finish(job?.id ?? '', mac, outcome, T2, auditOf('job.finished', slug), spent(1.5, slug));

    await save(slug, { budget: { monthly_usd: 25 } });
    expect(await teamState.get(slug)).toMatchObject({ pausedBy: 'owner', pausedAt: T1 });
    expect(await resumesOf(slug)).toBe(0);
    await save(slug, { budget: { monthly_usd: 1 } });
    expect(await teamState.get(slug)).toMatchObject({ pausedBy: 'owner', pausedAt: T1 });
    expect(await budgetPausesOf(slug)).toBe(1);
    await enqueue(slug);
    expect(await claimAs(mac)).toBeNull();
  });

  it('refuses the claim on the month’s spend alone (a lowered budget needs no finish), month by month', async () => {
    const slug = await project({ budget: { monthly_usd: 10 } });
    const mac = await runner([slug]);
    // Spend that reached the budget without a pause: the claim's own term must refuse it.
    await env.DB.prepare(
      `INSERT INTO project_spend (project_slug, month, spent_usd, jobs) VALUES (?1, '2026-11', 10, 1)`,
    )
      .bind(slug)
      .run();
    const id = await enqueue(slug);
    expect(await claimAs(mac)).toBeNull();
    expect((await claimAs(mac, DECEMBER))?.id).toBe(id);
  });

  it('a save lowering the budget to the spend pauses at once; raising it above lifts the pause', async () => {
    const slug = await project({ budget: { monthly_usd: 50 } });
    const mac = await runner([slug]);
    await enqueue(slug);
    await runOne(slug, mac, 20);
    expect((await teamState.get(slug)).pausedBy).toBeNull();

    await save(slug, { budget: { monthly_usd: 20 } });
    expect((await teamState.get(slug)).pausedBy).toBe(BUDGET_PAUSER);
    expect(await budgetPausesOf(slug)).toBe(1);
    // A save that leaves the budget used up changes nothing and writes no second row.
    await save(slug, { budget: { monthly_usd: 15 } });
    expect(await budgetPausesOf(slug)).toBe(1);

    await save(slug, { budget: { monthly_usd: 30 } });
    expect((await teamState.get(slug)).pausedAt).toBeNull();
    expect(await resumesOf(slug)).toBe(1);
    expect(await teamState.budgetStopsOf([slug], T2)).toEqual([]);
    await enqueue(slug);
    expect((await claimAs(mac))?.projectSlug).toBe(slug);
  });

  it('a save removing the budget lifts the stop too, but never an owner’s pause', async () => {
    const slug = await project({ budget: { monthly_usd: 5 } });
    const mac = await runner([slug]);
    await enqueue(slug);
    await runOne(slug, mac, 5);
    expect((await teamState.get(slug)).pausedBy).toBe(BUDGET_PAUSER);
    await save(slug, { budget: { monthly_usd: null } });
    expect((await teamState.get(slug)).pausedAt).toBeNull();

    expect(await teamState.pause(slug, 'owner', T2, auditOf('team.paused', slug))).toBe(true);
    await save(slug, { budget: { monthly_usd: 500 } });
    expect((await teamState.get(slug)).pausedBy).toBe('owner');
  });

  it('“Resume this month” lifts the stop and waives the month: claims resume, later finishes do not pause again', async () => {
    const slug = await project({ budget: { monthly_usd: 2 } });
    const mac = await runner([slug]);
    await enqueue(slug);
    await runOne(slug, mac, 3);
    expect((await teamState.get(slug)).pausedBy).toBe(BUDGET_PAUSER);

    expect(await resumeThisMonth(slug, T2)).toEqual({ resumed: true, waivedMonth: '2026-11' });
    expect(await waivedAtOf(slug, '2026-11')).toBe(T2);
    const waived = await env.DB.prepare(
      `SELECT details FROM audit_events WHERE kind = 'team.budget-waived' AND target = ?1`,
    )
      .bind(slug)
      .first<{ details: string }>();
    expect(JSON.parse(waived?.details ?? '{}')).toEqual({ waivedMonth: '2026-11' });
    await enqueue(slug);
    await runOne(slug, mac, 3);
    expect((await teamState.get(slug)).pausedAt).toBeNull();
    expect(await budgetPausesOf(slug)).toBe(1);
    expect(await teamState.budgetStopsOf([slug], T2)).toEqual([]);
  });

  it('a stop carried into the next month resumes with no waiver: the new month runs under its budget (regression)', async () => {
    const slug = await project({ budget: { monthly_usd: 2 } });
    const mac = await runner([slug]);
    await enqueue(slug);
    await runOne(slug, mac, 3);
    expect(await teamState.budgetStopsOf([slug], DECEMBER)).toEqual([
      { projectSlug: slug, stoppedAt: T2, month: '2026-11', spentUsd: 3, budgetUsd: 2 },
    ]);

    expect(await resumeThisMonth(slug, DECEMBER)).toEqual({ resumed: true, waivedMonth: null });
    expect(await waivedAtOf(slug, '2026-12')).toBeNull();
    expect(await waivedAtOf(slug, '2026-11')).toBeNull();
    // December's first job goes over the budget: the team stops again.
    await enqueue(slug);
    const job = await claimAs(mac, DECEMBER, DECEMBER_LEASE);
    const outcome = {
      result: 'finished' as const,
      summary: 's',
      metrics: { total_cost_usd: 2.5 },
      acted: false,
    };
    expect(
      await jobs.finish(
        job?.id ?? '',
        mac,
        outcome,
        DECEMBER_LATER,
        auditOf('job.finished', slug),
        spent(2.5, slug),
      ),
    ).toBe(true);
    expect(await teamState.get(slug)).toMatchObject({ pausedBy: BUDGET_PAUSER, pausedAt: DECEMBER_LATER });
    await enqueue(slug);
    expect(await claimAs(mac, DECEMBER_LATER, DECEMBER_LEASE)).toBeNull();
  });

  it('a plain resume (the commands panel) lifts the pause but never waives: the claim still refuses, the row stays (#733)', async () => {
    const slug = await project({ budget: { monthly_usd: 2 } });
    const mac = await runner([slug]);
    await enqueue(slug);
    await runOne(slug, mac, 3);
    expect(await teamState.resume(slug, T2, auditOf('team.resumed', slug))).toBe(true);
    expect(await waivedAtOf(slug, '2026-11')).toBeNull();
    await enqueue(slug);
    expect(await claimAs(mac)).toBeNull();
    expect(await teamState.budgetStopsOf([slug], T2)).toEqual([
      { projectSlug: slug, stoppedAt: null, month: '2026-11', spentUsd: 3, budgetUsd: 2 },
    ]);
    // The row's own resume then waives the month, though nothing was paused.
    expect(await resumeThisMonth(slug, T2)).toEqual({ resumed: false, waivedMonth: '2026-11' });
    expect((await claimAs(mac))?.projectSlug).toBe(slug);
  });

  it('a budget saved above the spend after a waiver ends it, so the new budget caps the month (#734)', async () => {
    const slug = await project({ budget: { monthly_usd: 1 } });
    const mac = await runner([slug]);
    await enqueue(slug);
    await runOne(slug, mac, 1.5);
    expect((await resumeThisMonth(slug, T2)).waivedMonth).toBe('2026-11');
    // A save that leaves the month at its budget keeps the waiver.
    await save(slug, { budget: { monthly_usd: 1 } });
    expect(await waivedAtOf(slug, '2026-11')).toBe(T2);

    await save(slug, { budget: { monthly_usd: 3 } });
    expect(await waivedAtOf(slug, '2026-11')).toBeNull();
    expect((await teamState.get(slug)).pausedAt).toBeNull();
    await enqueue(slug);
    await runOne(slug, mac, 2);
    expect((await teamState.get(slug)).pausedBy).toBe(BUDGET_PAUSER);
  });

  it('a budget lowered under the spend after a waiver ends it and pauses at once; the claim refuses (#737 regression)', async () => {
    const slug = await project({ budget: { monthly_usd: 10 } });
    const mac = await runner([slug]);
    await enqueue(slug);
    await runOne(slug, mac, 10);
    expect((await resumeThisMonth(slug, T2)).waivedMonth).toBe('2026-11');
    await enqueue(slug);
    // In flight across the save: its finish must not lift the stop the save sets.
    const inFlight = await claimAs(mac);
    await enqueue(slug);
    await runOne(slug, mac, 10);
    expect((await spend.findMonth(slug, '2026-11')).spentUsd).toBe(20);
    expect((await teamState.get(slug)).pausedAt).toBeNull();

    await save(slug, { budget: { monthly_usd: 5 } }, T2);
    expect(await waivedAtOf(slug, '2026-11')).toBeNull();
    expect(await teamState.get(slug)).toMatchObject({ pausedBy: BUDGET_PAUSER, pausedAt: T2 });
    expect(await teamState.budgetStopsOf([slug], T2)).toEqual([
      { projectSlug: slug, stoppedAt: T2, month: '2026-11', spentUsd: 20, budgetUsd: 5 },
    ]);
    expect(await claimAs(mac)).toBeNull();

    const outcome = {
      result: 'finished' as const,
      summary: 's',
      metrics: { total_cost_usd: 100 },
      acted: false,
    };
    expect(
      await jobs.finish(
        inFlight?.id ?? '',
        mac,
        outcome,
        T2,
        auditOf('job.finished', slug),
        spent(100, slug),
      ),
    ).toBe(true);
    expect((await teamState.get(slug)).pausedBy).toBe(BUDGET_PAUSER);
    expect(await claimAs(mac)).toBeNull();
  });

  it('a save that keeps the budget keeps the waiver, whatever else it changes (#737)', async () => {
    const slug = await project({ budget: { monthly_usd: 2 } });
    const mac = await runner([slug]);
    await enqueue(slug);
    await runOne(slug, mac, 3);
    expect((await resumeThisMonth(slug, T2)).waivedMonth).toBe('2026-11');
    await save(slug, { budget: { monthly_usd: 2 }, language: 'en' });
    expect(await waivedAtOf(slug, '2026-11')).toBe(T2);
    expect((await teamState.get(slug)).pausedAt).toBeNull();
    await enqueue(slug);
    expect((await claimAs(mac))?.projectSlug).toBe(slug);
  });

  it('resuming an owner’s pause waives nothing', async () => {
    const slug = await project({ budget: { monthly_usd: 2 } });
    expect(await teamState.pause(slug, 'owner', T1, auditOf('team.paused', slug))).toBe(true);
    expect(await teamState.resume(slug, T2, auditOf('team.resumed', slug))).toBe(true);
    expect(await count(`SELECT COUNT(*) AS n FROM project_spend WHERE project_slug = ?1`, slug)).toBe(0);
  });

  it('a finish without spend writes nothing of the budget (#732)', async () => {
    const slug = await project({ budget: { monthly_usd: 1 } });
    const mac = await runner([slug]);
    await enqueue(slug);
    const job = await claimAs(mac);
    const outcome = {
      result: 'finished' as const,
      summary: 's',
      metrics: { total_cost_usd: 5 },
      acted: false,
    };
    expect(await jobs.finish(job?.id ?? '', mac, outcome, T2, auditOf('job.finished', slug))).toBe(true);
    expect(await count(`SELECT COUNT(*) AS n FROM project_spend WHERE project_slug = ?1`, slug)).toBe(0);
    expect((await teamState.get(slug)).pausedAt).toBeNull();
  });
});

describe('the Actions dispatch admission (#722, #716)', () => {
  async function actionsProject(config: Partial<TeamConfig> = {}): Promise<string> {
    const slug = await project(config);
    await env.DB.prepare(`UPDATE projects SET dispatch = 'actions' WHERE slug = ?1`).bind(slug).run();
    return slug;
  }

  it('dispatches one job of a role at max_parallel 1 and holds the second until the first ends', async () => {
    const slug = await actionsProject({ roles: { dev: { max_parallel: 1 } } });
    const first = await enqueue(slug, 'dev', 1);
    const second = await enqueue(slug, 'dev', 0);
    expect(await jobs.listDispatchable(T1, 10, { projectSlug: slug })).toEqual([first, second]);
    expect(await jobs.markDispatched(first, T1)).toBe(true);
    // The first's run is on its way: it holds the slot before any exchange.
    expect((await jobs.findDispatchTarget(second, T1))?.admitted).toBe(false);
    expect(await jobs.markDispatched(second, T1)).toBe(false);
    expect(await jobs.listDispatchable(T1, 10, { projectSlug: slug })).toEqual([]);
    // The no-show clock runs from the dispatch: the dispatched job ends, the waiting one never does.
    expect(await jobs.failActionsNoShows('2026-11-16T11:00:00.000Z', 15, 'actions-no-show')).toEqual([first]);
    expect((await jobs.findById(second))?.state).toBe('queued');

    // The first job's end freed the slot.
    expect(await jobs.listDispatchable(T2, 10, { projectSlug: slug })).toEqual([second]);
    expect(await jobs.markDispatched(second, T2)).toBe(true);
  });

  it('of two dispatches racing for the last slot, one writes', async () => {
    const slug = await actionsProject({ roles: { dev: { max_parallel: 1 } } });
    const a = await enqueue(slug);
    const b = await enqueue(slug);
    const marks = await Promise.all([jobs.markDispatched(a, T1), jobs.markDispatched(b, T1)]);
    expect(marks.filter(Boolean)).toHaveLength(1);
  });

  it('holds back a paused team (the budget among pausers), a switched-off role and a used-up budget', async () => {
    const paused = await actionsProject();
    const job = await enqueue(paused);
    expect(await teamState.pause(paused, 'owner', T0, auditOf('team.paused', paused))).toBe(true);
    expect((await jobs.findDispatchTarget(job, T1))?.admitted).toBe(false);
    expect(await jobs.markDispatched(job, T1)).toBe(false);
    expect(await teamState.resume(paused, T1, auditOf('team.resumed', paused))).toBe(true);
    expect(await jobs.markDispatched(job, T1)).toBe(true);

    const off = await actionsProject({ roles: { analyst: { enabled: false } } });
    const analyst = await enqueue(off, 'analyst');
    expect(await jobs.markDispatched(analyst, T1)).toBe(false);
    expect(await jobs.listDispatchable(T1, 10, { projectSlug: off })).toEqual([]);

    const broke = await actionsProject({ budget: { monthly_usd: 1 } });
    await env.DB.prepare(
      `INSERT INTO project_spend (project_slug, month, spent_usd) VALUES (?1, '2026-11', 1)`,
    )
      .bind(broke)
      .run();
    const late = await enqueue(broke);
    expect(await jobs.markDispatched(late, T1)).toBe(false);
    expect(await jobs.markDispatched(late, DECEMBER)).toBe(true);
  });
});

// #723 item 2: the run the dispatch call named, the only one the exchange then takes the job for.
describe('the run a dispatch recorded (#723 item 2)', () => {
  /** A queued Actions job of an API-key project, dispatched at T1 unless `dispatched` is false. */
  async function actionsJob(dispatched = true): Promise<string> {
    const slug = await project();
    await env.DB.prepare(`UPDATE projects SET dispatch = 'actions' WHERE slug = ?1`).bind(slug).run();
    const id = await enqueue(slug);
    if (dispatched) {
      expect(await jobs.markDispatched(id, T1)).toBe(true);
    }
    return id;
  }

  const runOf = async (id: string): Promise<string | null> =>
    (
      await env.DB.prepare(`SELECT actions_run_id FROM jobs WHERE id = ?1`)
        .bind(id)
        .first<{ actions_run_id: string | null }>()
    )?.actions_run_id ?? null;

  it('records the run on a dispatched job waiting for it, and answers the job as written', async () => {
    const id = await actionsJob();
    const job = await jobs.recordDispatchedRun(id, '7300000001');
    expect(job).toMatchObject({ id, state: 'queued', dispatch: 'actions', runnerId: null });
    expect(await runOf(id)).toBe('7300000001');
    expect((await jobs.findActionsTarget(id))?.dispatchedRunId).toBe('7300000001');
  });

  it('writes the run once: a second answer never replaces it', async () => {
    const id = await actionsJob();
    expect(await jobs.recordDispatchedRun(id, '7300000002')).not.toBeNull();
    expect(await jobs.recordDispatchedRun(id, '7300000003')).toBeNull();
    expect(await runOf(id)).toBe('7300000002');
  });

  it('answers null for a job never dispatched, one no longer queued, and a pulled one', async () => {
    const undispatched = await actionsJob(false);
    const cancelled = await actionsJob();
    await env.DB.prepare(`UPDATE jobs SET state = 'cancelled', finished_at = ?2 WHERE id = ?1`)
      .bind(cancelled, T2)
      .run();
    const pulled = await enqueue(await project());
    for (const [id, runId] of [
      [undispatched, '7300000004'],
      [cancelled, '7300000005'],
      [pulled, '7300000006'],
    ] as const) {
      expect(await jobs.recordDispatchedRun(id, runId)).toBeNull();
      expect(await runOf(id)).toBeNull();
    }
  });

  it('answers null, not an error, for a run another job already holds (0031 unique index)', async () => {
    const first = await actionsJob();
    const second = await actionsJob();
    expect(await jobs.recordDispatchedRun(first, '7300000007')).not.toBeNull();
    expect(await jobs.recordDispatchedRun(second, '7300000007')).toBeNull();
    expect(await runOf(second)).toBeNull();
  });

  it('is not a run already seen until a run exchanged for it', async () => {
    const id = await actionsJob();
    await jobs.recordDispatchedRun(id, '7300000008');
    expect(await jobs.isActionsRunSeen('7300000008')).toBe(false);
    await env.DB.prepare(`UPDATE jobs SET claimed_at = ?2 WHERE id = ?1`).bind(id, T2).run();
    expect(await jobs.isActionsRunSeen('7300000008')).toBe(true);
  });

  it('answers the job as failed from failUndispatched (#725), and null once it no longer waits', async () => {
    const id = await actionsJob();
    const failed = await jobs.failUndispatched(id, T2, 'dispatch-failed', 'dispatch-failed: github error');
    expect(failed).toMatchObject({
      id,
      state: 'failed',
      finishedAt: T2,
      result: { summary: 'dispatch-failed: github error' },
    });
    expect(await jobs.failUndispatched(id, T2, 'dispatch-failed', 'again')).toBeNull();
  });
});
