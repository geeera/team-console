import { env } from 'cloudflare:test';
import { TEAM_CONFIG_SCHEMA, type AccessSource, type TeamConfig } from '@shared/contracts';
import { AccountsRepo } from '../accounts/accounts.repo';
import type { NewAuditEvent } from '../accounts/audit.repo';
import { JobsRepo, type ClaimRequest, type JobRecord } from '../jobs/jobs.repo';
import { ProjectSpendRepo, utcMonthOf } from './project-spend.repo';
import { TeamConfigRepo, type TeamConfigWrite } from './team-config.repo';

// #687 (ADR 0009 d.3, d.6–d.8; threat model C12): the team-config storage, its triggers, and what the claim, the
// placement writes and the enqueue make of it — directly against D1.

const ACCOUNT = '01M6YSNJ00000000000000TCA1';
const T0 = '2026-11-16T10:00:00.000Z';
const T1 = '2026-11-16T10:05:00.000Z';
const LEASE = '2026-11-16T10:10:00.000Z';

let counter = 0;
const ulid = (tag: string): string => {
  counter += 1;
  return `01M6YSNJ00000000000${tag}${String(counter).padStart(5, '0')}`.slice(0, 26);
};

const repo = new TeamConfigRepo(env.DB);
const jobs = new JobsRepo(env.DB);

beforeAll(async () => {
  await env.DB.prepare(`INSERT INTO accounts (id, slug, name, created_at) VALUES (?1, 'tc-a', 'A', ?2)`).bind(ACCOUNT, T0).run();
});

async function project(policy: string | null = null): Promise<string> {
  counter += 1;
  const slug = `tc-${String(counter)}`;
  await env.DB.prepare(
    `INSERT INTO projects (slug, repo, display_name, cache_epoch, added_at, account_id, runner_policy)
     VALUES (?1, ?2, ?1, 0, ?3, ?4, ?5)`,
  )
    .bind(slug, `acme/${slug}`, T0, ACCOUNT, policy)
    .run();
  return slug;
}

async function runner(
  allowed: readonly string[],
  options: { hosted?: boolean; isolation?: string; maxConcurrency?: number } = {},
): Promise<string> {
  const id = ulid('RN');
  await env.DB.prepare(
    `INSERT INTO runners (id, account_id, name, public_key_jwk, capabilities, hosted, isolation, allowed_projects, version, enrolled_at)
     VALUES (?1, ?2, 'r', ?3, ?4, ?5, ?6, ?7, '0.1.0', ?8)`,
  )
    .bind(
      id,
      ACCOUNT,
      JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: 'x'.repeat(43) }),
      JSON.stringify({ local: true, maxConcurrency: options.maxConcurrency ?? 8 }),
      options.hosted === true ? 1 : 0,
      options.isolation ?? 'user',
      JSON.stringify(allowed),
      T0,
    )
    .run();
  return id;
}

const audit = (target: string): NewAuditEvent => ({
  accountId: ACCOUNT,
  at: T0,
  actorKind: 'user',
  actor: 'owner',
  kind: 'team-config.changed',
  target,
  details: { revision_from: 0, revision_to: 1, paths: ['preset'] },
});

function write(slug: string, expected: number, config: Partial<TeamConfig> = {}, source: AccessSource = 'api_key'): TeamConfigWrite {
  return {
    projectSlug: slug,
    expectedRevision: expected,
    config: { schema: TEAM_CONFIG_SCHEMA, ...config, access: { source } },
    diff: [{ path: 'preset', to: 'economy' }],
    reason: null,
    id: ulid('RV'),
    at: T0,
    by: 'owner',
    audit: audit(slug),
  };
}

async function count(sql: string, ...params: unknown[]): Promise<number> {
  return (await env.DB.prepare(sql).bind(...params).first<{ n: number }>())?.n ?? 0;
}

const revisionsOf = (slug: string) => count('SELECT COUNT(*) AS n FROM team_config_revisions WHERE project_slug = ?1', slug);
const auditsOf = (slug: string) =>
  count(`SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'team-config.changed' AND target = ?1`, slug);

async function currentEqualsMax(slug: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT (SELECT revision FROM team_configs WHERE project_slug = ?1) AS current,
            (SELECT MAX(revision) FROM team_config_revisions WHERE project_slug = ?1) AS max`,
  )
    .bind(slug)
    .first<{ current: number | null; max: number | null }>();
  return row !== null && row.current === row.max;
}

describe('TeamConfigRepo.save', () => {
  it('writes the first revision, its history row, the audit row and the access source in one batch', async () => {
    const slug = await project();
    expect(await repo.accessSourceOf(slug)).toBe('subscription');
    expect(await repo.save(write(slug, 0, { preset: 'economy' }))).toEqual({ kind: 'saved', revision: 1 });
    const current = await repo.findCurrent(slug);
    expect(current?.revision).toBe(1);
    expect(current?.config).toEqual({ schema: TEAM_CONFIG_SCHEMA, preset: 'economy', access: { source: 'api_key' } });
    expect((await repo.findRevision(slug, 1))?.diff).toEqual([{ path: 'preset', to: 'economy' }]);
    expect(await auditsOf(slug)).toBe(1);
    expect(await repo.accessSourceOf(slug)).toBe('api_key');
  });

  it('moves one revision at a time and answers stale for an old or a future If-Match, writing nothing', async () => {
    const slug = await project();
    await repo.save(write(slug, 0));
    expect(await repo.save(write(slug, 1, { preset: 'max' }))).toEqual({ kind: 'saved', revision: 2 });
    expect(await repo.save(write(slug, 1, { preset: 'economy' }))).toEqual({ kind: 'stale', revision: 2 });
    expect(await repo.save(write(slug, 7, { preset: 'economy' }))).toEqual({ kind: 'stale', revision: 2 });
    expect(await repo.save(write(slug, 0, { preset: 'economy' }))).toEqual({ kind: 'stale', revision: 2 });
    expect(await revisionsOf(slug)).toBe(2);
    expect(await auditsOf(slug)).toBe(2);
    expect(await currentEqualsMax(slug)).toBe(true);
  });

  it('gives two concurrent saves of the same revision one success and one stale', async () => {
    const slug = await project();
    await repo.save(write(slug, 0));
    const outcomes = await Promise.all([repo.save(write(slug, 1, { preset: 'max' })), repo.save(write(slug, 1, { preset: 'economy' }))]);
    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(['saved', 'stale']);
    expect(await revisionsOf(slug)).toBe(2);
    expect(await currentEqualsMax(slug)).toBe(true);
  });

  it('keeps the current revision equal to the highest after a batch that failed', async () => {
    const slug = await project();
    await repo.save(write(slug, 0));
    // A reason past the column's bound fails the revision INSERT, so the whole batch rolls back with it.
    await expect(repo.save({ ...write(slug, 1, { preset: 'max' }), reason: 'x'.repeat(501) })).rejects.toThrow();
    expect((await repo.findCurrent(slug))?.revision).toBe(1);
    expect(await revisionsOf(slug)).toBe(1);
    expect(await auditsOf(slug)).toBe(1);
    expect(await currentEqualsMax(slug)).toBe(true);
  });

  it('refuses a subscription while the effective policy admits a hosted runner, inside the write', async () => {
    const pinnedToMac = await project();
    const open = await project();
    await runner([], { hosted: true });
    expect(await repo.save(write(open, 0, {}, 'subscription'))).toEqual({ kind: 'access-source-hosted' });
    expect(await repo.findCurrent(open)).toBeNull();
    expect(await auditsOf(open)).toBe(0);
    expect(await repo.save(write(open, 0, {}, 'api_key'))).toEqual({ kind: 'saved', revision: 1 });
    // A policy that pins the project to a self-hosted runner admits no hosted one.
    const mac = await runner([pinnedToMac]);
    await env.DB.prepare(`UPDATE projects SET runner_policy = ?2 WHERE slug = ?1`)
      .bind(pinnedToMac, JSON.stringify({ mode: 'pinned', runner: mac }))
      .run();
    expect(await repo.save(write(pinnedToMac, 0, {}, 'subscription'))).toEqual({ kind: 'saved', revision: 1 });
    await env.DB.prepare(`UPDATE runners SET revoked_at = ?1 WHERE hosted = 1`).bind(T0).run();
  });

  it('refuses a subscription while the project is dispatched to GitHub Actions, inside the write (0031)', async () => {
    const slug = await project();
    await env.DB.prepare(`UPDATE projects SET dispatch = 'actions' WHERE slug = ?1`).bind(slug).run();
    expect(await repo.save(write(slug, 0, {}, 'subscription'))).toEqual({ kind: 'access-source-hosted' });
    expect(await repo.findCurrent(slug)).toBeNull();
    expect(await auditsOf(slug)).toBe(0);
    expect(await repo.save(write(slug, 0, {}, 'api_key'))).toEqual({ kind: 'saved', revision: 1 });
    // Leaving the API key is refused just the same, and the stored source stays.
    expect(await repo.save(write(slug, 1, {}, 'subscription'))).toEqual({ kind: 'access-source-hosted' });
    expect(await repo.accessSourceOf(slug)).toBe('api_key');
    // Back on pull, nothing else stops it.
    await env.DB.prepare(`UPDATE projects SET dispatch = 'pull' WHERE slug = ?1`).bind(slug).run();
    expect(await repo.save(write(slug, 1, {}, 'subscription'))).toEqual({ kind: 'saved', revision: 2 });
  });
});

describe('the 0032 triggers', () => {
  it('keep team_config_revisions append-only: UPDATE, DELETE and INSERT OR REPLACE fail', async () => {
    const slug = await project();
    await repo.save(write(slug, 0));
    await expect(env.DB.prepare(`UPDATE team_config_revisions SET reason = 'x' WHERE project_slug = ?1`).bind(slug).run()).rejects.toThrow(
      /append-only/,
    );
    await expect(env.DB.prepare(`DELETE FROM team_config_revisions WHERE project_slug = ?1`).bind(slug).run()).rejects.toThrow(
      /append-only/,
    );
    await expect(
      env.DB.prepare(
        `INSERT OR REPLACE INTO team_config_revisions (id, project_slug, revision, config, diff, created_at, created_by)
         SELECT id, project_slug, revision, config, '[]', created_at, 'intruder' FROM team_config_revisions WHERE project_slug = ?1`,
      )
        .bind(slug)
        .run(),
    ).rejects.toThrow(/append-only/);
    expect((await repo.findRevision(slug, 1))?.createdBy).toBe('owner');
  });

  it('refuse a revision that is not the current document, and a current row that skips or is replaced', async () => {
    const slug = await project();
    await repo.save(write(slug, 0));
    await expect(
      env.DB.prepare(
        `INSERT INTO team_config_revisions (id, project_slug, revision, config, diff, created_at, created_by)
         VALUES (?1, ?2, 2, '{"schema":"team-config/v1"}', '[]', ?3, 'x')`,
      )
        .bind(ulid('RV'), slug, T0)
        .run(),
    ).rejects.toThrow(/current team configuration/);
    await expect(env.DB.prepare(`UPDATE team_configs SET revision = 5 WHERE project_slug = ?1`).bind(slug).run()).rejects.toThrow(
      /one revision at a time/,
    );
    await expect(
      env.DB.prepare(
        `INSERT OR REPLACE INTO team_configs (project_slug, revision, config, updated_at, updated_by) VALUES (?1, 1, '{}', ?2, 'x')`,
      )
        .bind(slug, T0)
        .run(),
    ).rejects.toThrow(/never replaced/);
    expect(await currentEqualsMax(slug)).toBe(true);
  });

  it('let projects.access_source take only the current document’s source', async () => {
    const slug = await project();
    await expect(env.DB.prepare(`UPDATE projects SET access_source = 'api_key' WHERE slug = ?1`).bind(slug).run()).rejects.toThrow(
      /follows the team configuration/,
    );
    await repo.save(write(slug, 0, {}, 'api_key'));
    await expect(env.DB.prepare(`UPDATE projects SET access_source = 'subscription' WHERE slug = ?1`).bind(slug).run()).rejects.toThrow(
      /follows the team configuration/,
    );
  });

  it('never queue an Actions or hosted job for a subscription project, and do for an API-key one', async () => {
    const subscription = await project();
    const apiKey = await project();
    await repo.save(write(apiKey, 0, {}, 'api_key'));
    const insert = (slug: string, dispatch: string) =>
      env.DB.prepare(
        `INSERT INTO jobs (id, account_id, project_slug, kind, role, requested_by, dispatch, created_at)
         VALUES (?1, ?2, ?3, 'slot-dev', 'orchestrator', 'owner', ?4, ?5)`,
      )
        .bind(ulid('JB'), ACCOUNT, slug, dispatch, T0)
        .run();
    for (const dispatch of ['actions', 'hosted']) {
      await expect(insert(subscription, dispatch)).rejects.toThrow(/access-source-hosted/);
      await expect(insert(apiKey, dispatch)).resolves.toBeDefined();
    }
    await expect(insert(subscription, 'pull')).resolves.toBeDefined();
  });
});

describe('placement writes and the access source (the reverse refusal)', () => {
  const accounts = new AccountsRepo(env.DB);
  const policyAudit = (target: string): NewAuditEvent => ({ ...audit(target), kind: 'runner.policy-changed' });

  it('refuses a project policy that would admit a hosted runner while the project is on a subscription', async () => {
    const slug = await project();
    const mac = await runner([slug]);
    const hosted = await runner([slug], { hosted: true });
    await env.DB.prepare(`UPDATE projects SET runner_policy = ?2 WHERE slug = ?1`).bind(slug, JSON.stringify({ mode: 'pinned', runner: mac })).run();
    expect(await accounts.setProjectRunnerPolicy(slug, JSON.stringify({ mode: 'pinned', runner: hosted }), policyAudit(slug))).toBe(
      'access-source-hosted',
    );
    expect(await accounts.setProjectRunnerPolicy(slug, JSON.stringify({ mode: 'any' }), policyAudit(slug))).toBe('access-source-hosted');
    expect(await accounts.setProjectRunnerPolicy(slug, JSON.stringify({ mode: 'pinned', runner: mac }), policyAudit(slug))).toBe('ok');
    expect(await count(`SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'runner.policy-changed' AND target = ?1`, slug)).toBe(1);
    await repo.save(write(slug, 0, {}, 'api_key'));
    expect(await accounts.setProjectRunnerPolicy(slug, JSON.stringify({ mode: 'any' }), policyAudit(slug))).toBe('ok');
    await env.DB.prepare(`UPDATE runners SET revoked_at = ?1 WHERE id = ?2`).bind(T0, hosted).run();
  });

  it('refuses an account default that would reach a subscription project falling back to it', async () => {
    const slug = await project();
    const hosted = await runner([slug], { hosted: true });
    expect(await accounts.setDefaultRunnerPolicy(ACCOUNT, JSON.stringify({ mode: 'any' }), policyAudit(ACCOUNT))).toBe(
      'access-source-hosted',
    );
    expect(await accounts.setDefaultRunnerPolicy(ACCOUNT, JSON.stringify({ mode: 'pinned', runner: hosted }), policyAudit(ACCOUNT))).toBe(
      'access-source-hosted',
    );
    await env.DB.prepare(`UPDATE runners SET revoked_at = ?1 WHERE id = ?2`).bind(T0, hosted).run();
    expect(await accounts.setDefaultRunnerPolicy(ACCOUNT, JSON.stringify({ mode: 'any' }), policyAudit(ACCOUNT))).toBe('ok');
    await accounts.setDefaultRunnerPolicy(ACCOUNT, null, policyAudit(ACCOUNT));
  });
});

describe('the claim and the team configuration', () => {
  let token = 0;
  const claimAs = (runnerId: string, overrides: Partial<ClaimRequest> = {}): Promise<JobRecord | null> => {
    token += 1;
    return jobs.claim({
      runnerId,
      accountId: ACCOUNT,
      local: true,
      tokenHash: token.toString(16).padStart(64, '0'),
      now: T1,
      leaseUntil: LEASE,
      ...overrides,
    });
  };

  async function enqueue(slug: string, role = 'orchestrator', kind: 'slot-dev' | 'review' | 'digest' = 'slot-dev'): Promise<string> {
    const id = ulid('JB');
    expect(
      await jobs.enqueue(
        { id, accountId: ACCOUNT, projectSlug: slug, kind, role, payload: {}, priority: 0, requestedBy: 'owner', dedupeKey: null, needsLocal: false, maxMinutes: 90, at: T0 },
        { ...audit(slug), kind: 'job.dispatched' },
      ),
    ).toBe('ok');
    return id;
  }

  it('lets a hosted runner pull a subscription project’s job never, an API-key project’s job yes', async () => {
    const subscription = await project();
    const apiKey = await project();
    await repo.save(write(apiKey, 0, {}, 'api_key'));
    const hosted = await runner([subscription, apiKey], { hosted: true });
    const job = await enqueue(subscription);
    expect(await claimAs(hosted)).toBeNull();
    expect((await jobs.findById(job))?.state).toBe('queued');
    await enqueue(apiKey);
    expect((await claimAs(hosted))?.projectSlug).toBe(apiKey);
    await env.DB.prepare(`UPDATE runners SET revoked_at = ?1 WHERE id = ?2`).bind(T0, hosted).run();
  });

  it('never treats an actions-ephemeral runner (hosted = 0) as self-hosted for a subscription project', async () => {
    const subscription = await project();
    const ephemeral = await runner([subscription], { isolation: 'actions-ephemeral' });
    await enqueue(subscription);
    expect(await claimAs(ephemeral)).toBeNull();
    const mac = await runner([subscription]);
    expect((await claimAs(mac))?.runnerId).toBe(mac);
  });

  it('skips a role the document switched off, and claims it again once it is back on', async () => {
    const slug = await project();
    await repo.save(write(slug, 0, { roles: { analyst: { enabled: false } } }));
    const mac = await runner([slug]);
    const analyst = await enqueue(slug, 'analyst', 'digest');
    expect(await claimAs(mac)).toBeNull();
    await repo.save(write(slug, 1, { roles: { analyst: { enabled: true } } }));
    expect((await claimAs(mac))?.id).toBe(analyst);
  });

  it('holds a role to max_parallel inside the claim: two concurrent claims give one', async () => {
    const slug = await project();
    await repo.save(write(slug, 0, { roles: { reviewer: { max_parallel: 1 } } }));
    const first = await runner([slug]);
    const second = await runner([slug]);
    await enqueue(slug, 'reviewer', 'review');
    await enqueue(slug, 'reviewer', 'review');
    const claims = await Promise.all([claimAs(first), claimAs(second)]);
    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    // Another role of the project is not held back by the reviewer's cap.
    await enqueue(slug, 'qa', 'review');
    expect((await claimAs(second))?.role).toBe('qa');
  });

  it('falls back to the preset’s max_parallel for a role the document leaves out', async () => {
    const slug = await project();
    const mac = await runner([slug]);
    for (let n = 0; n < 6; n += 1) {
      await enqueue(slug, 'dev', 'slot-dev');
    }
    const claimed = [];
    for (let n = 0; n < 6; n += 1) {
      claimed.push(await claimAs(mac));
    }
    // `recommended` caps a role at the bound's top, 5: the sixth waits.
    expect(claimed.filter((claim) => claim !== null)).toHaveLength(5);
  });

  it('stamps the current revision at claim, so a later change applies to the next claim only', async () => {
    const plain = await project();
    const mac = await runner([plain]);
    await enqueue(plain);
    expect((await claimAs(mac))?.teamConfigRevision).toBeNull();

    const slug = await project();
    await env.DB.prepare(`UPDATE runners SET allowed_projects = ?2 WHERE id = ?1`).bind(mac, JSON.stringify([slug])).run();
    await repo.save(write(slug, 0));
    await enqueue(slug);
    await enqueue(slug);
    const claimed = await claimAs(mac);
    expect(claimed?.teamConfigRevision).toBe(1);
    await repo.save(write(slug, 1, { preset: 'max' }));
    expect((await jobs.findById(claimed?.id ?? ''))?.teamConfigRevision).toBe(1);
    expect((await claimAs(mac))?.teamConfigRevision).toBe(2);
  });
});

describe('who writes projects.access_source', () => {
  it('is TeamConfigRepo alone among the library’s sources', () => {
    const writers = Object.entries(env.TEST_LIBRARY_SOURCES)
      .filter(([, source]) => /SET\s+(?:[a-z_]+\s*=\s*[^,]+,\s*)*access_source\s*=/i.test(source))
      .map(([file]) => file);
    expect(writers).toEqual(['lib/team-config/team-config.repo.ts']);
  });
});

describe('ProjectSpendRepo', () => {
  it('reads a month with no row as nothing spent, and a row as stored', async () => {
    const slug = await project();
    const spend = new ProjectSpendRepo(env.DB);
    expect(await spend.findMonth(slug, '2026-11')).toEqual({ projectSlug: slug, month: '2026-11', spentUsd: 0, jobs: 0, waivedAt: null });
    await env.DB.prepare(`INSERT INTO project_spend (project_slug, month, spent_usd, jobs) VALUES (?1, '2026-11', 12.5, 3)`).bind(slug).run();
    expect(await spend.findMonth(slug, '2026-11')).toEqual({ projectSlug: slug, month: '2026-11', spentUsd: 12.5, jobs: 3, waivedAt: null });
    await env.DB.prepare(`UPDATE project_spend SET waived_at = '2026-11-20T08:00:00.000Z' WHERE project_slug = ?1`).bind(slug).run();
    expect((await spend.findMonth(slug, '2026-11')).waivedAt).toBe('2026-11-20T08:00:00.000Z');
    await expect(
      env.DB.prepare(`INSERT INTO project_spend (project_slug, month, spent_usd) VALUES (?1, '2026-12', -1)`).bind(slug).run(),
    ).rejects.toThrow();
  });

  it('names the UTC month of an instant', () => {
    expect(utcMonthOf('2026-11-30T23:59:59.000Z')).toBe('2026-11');
    expect(utcMonthOf('2026-12-01T00:30:00+02:00')).toBe('2026-11');
    expect(() => utcMonthOf('not a date')).toThrow(RangeError);
  });
});
