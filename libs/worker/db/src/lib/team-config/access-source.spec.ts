import { env } from 'cloudflare:test';
import { RUNNER_STILL_ALLOWS_SQL } from '../jobs/jobs.repo';
import {
  claimPlacementAdmitsSql,
  hostedRunnerAdmittedSql,
  runnerFitsAccessSourceSql,
  runnerScopeCoversSql,
  runnerServesSql,
} from './access-source';

/**
 * #775, R-SCOPE-3 and R-SCOPE-4: the project term is `runnerServesSql`, the job-token term keeps the account equality
 * beside it, the subscription invariant (`hostedRunnerAdmittedSql`, C12 row 6) stays blind to scope and list alike,
 * and the term answers against D1 the way the claim does. The source-text half (no inline `json_each` term outside
 * `runnerServesSql`, the claim's account equality) is `tools/workspace-checks/src/runner-scope-sql.spec.ts`.
 *
 * #809: the claim's other runner terms, each run against D1 on bound values, one case per branch. That the claim and
 * `availabilityOf` use the same terms is `tools/workspace-checks/src/claim-availability-agreement.spec.ts`.
 */

const KEY = JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: 'x'.repeat(43) });

/** The term's answer, 1 or 0, for one set of bound values. */
async function answer(sql: string, ...values: unknown[]): Promise<number> {
  const row = await env.DB.prepare(`SELECT (${sql}) AS ok`)
    .bind(...values)
    .first<{ ok: number }>();
  return row?.ok ?? -1;
}

describe('runnerServesSql', () => {
  it('is ANDed with the account equality in every job-token write', () => {
    expect(RUNNER_STILL_ALLOWS_SQL).toContain('r.account_id = jobs.account_id');
    expect(RUNNER_STILL_ALLOWS_SQL).toContain(runnerServesSql('r', 'jobs.project_slug'));
  });

  it('keeps hostedRunnerAdmittedSql blind to the scope and the list (C12 row 6)', () => {
    const term = hostedRunnerAdmittedSql('?1', 'NULL');
    expect(term).not.toContain('project_scope');
    expect(term).not.toContain('allowed_projects');
  });

  it('answers all, selected and D3 against D1 the way the claim does', async () => {
    const account = '01M6YSNJ0000000000000RSQ01';
    const key = JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: 'x'.repeat(43) });
    const runner = (
      id: string,
      scope: 'all' | 'selected',
      list: readonly string[],
      enrolledBy: string | null,
      sources: readonly string[] | null,
    ) =>
      env.DB.prepare(
        `INSERT INTO runners (id, account_id, name, public_key_jwk, capabilities, isolation, project_scope, allowed_projects, enrolled_by, version, enrolled_at)
           VALUES (?1, ?2, 'r', ?3, ?4, 'user', ?5, ?6, ?7, '0.1.0', '2026-11-17T00:00:00.000Z')`,
      ).bind(
        id,
        account,
        key,
        JSON.stringify(
          sources === null
            ? { local: true, maxConcurrency: 1 }
            : { local: true, maxConcurrency: 1, accessSources: sources },
        ),
        scope,
        JSON.stringify(list),
        enrolledBy,
      );
    const project = (slug: string, createdBy: string | null) =>
      env.DB.prepare(
        `INSERT INTO projects (slug, repo, display_name, cache_epoch, added_at, account_id, created_by) VALUES (?1, ?2, ?1, 0, '2026-11-17T00:00:00.000Z', ?3, ?4)`,
      ).bind(slug, `acme/${slug}`, account, createdBy);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO accounts (id, slug, name, created_at) VALUES (?1, 'rsql', 'R', '2026-11-17T00:00:00.000Z')`,
      ).bind(account),
      project('rsql-mine', 'owner-1'),
      project('rsql-theirs', 'owner-2'),
      runner('01M6YSNJ0000000000000RSQA1', 'all', [], 'owner-1', ['subscription']),
      runner('01M6YSNJ0000000000000RSQK1', 'all', [], 'owner-1', ['api_key']),
      runner('01M6YSNJ0000000000000RSQS1', 'selected', ['rsql-theirs'], 'owner-1', ['subscription']),
      // #824: entries another owner added, on a subscription runner and on an API-key one.
      runner('01M6YSNJ0000000000000RSQN1', 'selected', ['rsql-mine', 'rsql-theirs'], 'owner-1', [
        'subscription',
      ]),
      runner('01M6YSNJ0000000000000RSQN2', 'selected', ['rsql-mine', 'rsql-theirs'], 'owner-1', ['api_key']),
      env.DB.prepare(
        `UPDATE runners SET non_enroller_projects = '["rsql-mine","rsql-theirs"]' WHERE id IN ('01M6YSNJ0000000000000RSQN1', '01M6YSNJ0000000000000RSQN2')`,
      ),
    ]);
    const served = async (): Promise<string[]> => {
      const { results } = await env.DB.prepare(
        `SELECT r.id || ':' || p.slug AS pair FROM runners r JOIN projects p ON p.account_id = r.account_id
           WHERE r.account_id = ?1 AND ${runnerServesSql('r', 'p.slug')} ORDER BY pair`,
      )
        .bind(account)
        .all<{ pair: string }>();
      return results.map((row) => row.pair);
    };
    // One owner: `all` is the whole account, `selected` its list.
    expect(await served()).toEqual([
      '01M6YSNJ0000000000000RSQA1:rsql-mine',
      '01M6YSNJ0000000000000RSQA1:rsql-theirs',
      '01M6YSNJ0000000000000RSQK1:rsql-mine',
      '01M6YSNJ0000000000000RSQK1:rsql-theirs',
      '01M6YSNJ0000000000000RSQN1:rsql-mine',
      '01M6YSNJ0000000000000RSQN1:rsql-theirs',
      '01M6YSNJ0000000000000RSQN2:rsql-mine',
      '01M6YSNJ0000000000000RSQN2:rsql-theirs',
      '01M6YSNJ0000000000000RSQS1:rsql-theirs',
    ]);
    // Two owners (D3): the subscription runner under `all` keeps its enroller's project only, and so do the entries
    // another owner added to a subscription runner (#824); the API-key runners and the enroller's own selection are
    // unchanged.
    for (const n of [1, 2]) {
      const user = `01M6YSNJ0000000000000RSQM${String(n)}`;
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO users (id, provider, provider_user_id, login, created_at, last_seen_at) VALUES (?1, 'github', ?2, ?3, '2026-11-17T00:00:00.000Z', '2026-11-17T00:00:00.000Z')`,
        ).bind(user, String(770000 + n), `rsql-${String(n)}`),
        env.DB.prepare(
          `INSERT INTO account_members (account_id, user_id, role, joined_at) VALUES (?1, ?2, 'owner', '2026-11-17T00:00:00.000Z')`,
        ).bind(account, user),
      ]);
    }
    expect(await served()).toEqual([
      '01M6YSNJ0000000000000RSQA1:rsql-mine',
      '01M6YSNJ0000000000000RSQK1:rsql-mine',
      '01M6YSNJ0000000000000RSQK1:rsql-theirs',
      '01M6YSNJ0000000000000RSQN1:rsql-mine',
      '01M6YSNJ0000000000000RSQN2:rsql-mine',
      '01M6YSNJ0000000000000RSQN2:rsql-theirs',
      '01M6YSNJ0000000000000RSQS1:rsql-theirs',
    ]);
  });
});

describe('claimPlacementAdmitsSql', () => {
  const account = '01M6YSNJ0000000000000CPA01';
  const me = '01M6YSNJ0000000000000CPAME';
  const now = '2026-11-27T12:00:00.000Z';
  // ?1 policy, ?2 runner, ?3 now, ?4 offline default (seconds).
  const term = claimPlacementAdmitsSql('?1', '?2', '?3', '?4');
  const admits = (policy: object | null, offlineDefault = 300) =>
    answer(term, policy === null ? null : JSON.stringify(policy), me, now, offlineDefault);

  beforeAll(async () => {
    const preferred = (id: string, lastSeen: string | null, revokedAt: string | null) =>
      env.DB.prepare(
        `INSERT INTO runners (id, account_id, name, public_key_jwk, isolation, version, enrolled_at, last_seen_at, revoked_at)
           VALUES (?1, ?2, 'p', ?3, 'user', '0.1.0', '2026-11-01T00:00:00.000Z', ?4, ?5)`,
      ).bind(id, account, KEY, lastSeen, revokedAt);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO accounts (id, slug, name, created_at) VALUES (?1, 'cpa', 'C', '2026-11-01T00:00:00.000Z')`,
      ).bind(account),
      // Seen 60 s before `now`; seen 600 s before; never seen; revoked while fresh.
      preferred('01M6YSNJ0000000000000CPAN1', '2026-11-27T11:59:00.000Z', null),
      preferred('01M6YSNJ0000000000000CPAS1', '2026-11-27T11:50:00.000Z', null),
      preferred('01M6YSNJ0000000000000CPAV1', null, null),
      preferred('01M6YSNJ0000000000000CPAR1', '2026-11-27T11:59:00.000Z', '2026-11-27T11:59:30.000Z'),
    ]);
  });

  const failover = (preferredId: string, fallback: readonly string[], extra: object = {}) => ({
    mode: 'failover',
    preferred: preferredId,
    fallback,
    ...extra,
  });

  it('admits any runner without a policy and under `any`', async () => {
    expect(await admits(null)).toBe(1);
    expect(await admits({ mode: 'any' })).toBe(1);
  });

  it('admits under `pinned` only the pinned runner', async () => {
    expect(await admits({ mode: 'pinned', runner: me })).toBe(1);
    expect(await admits({ mode: 'pinned', runner: '01M6YSNJ0000000000000CPAN1' })).toBe(0);
  });

  it('admits the preferred under `failover` whatever its state', async () => {
    expect(await admits(failover(me, []))).toBe(1);
  });

  it('holds a fallback back while the preferred is online and unrevoked', async () => {
    expect(await admits(failover('01M6YSNJ0000000000000CPAN1', [me]))).toBe(0);
  });

  it('admits a fallback once the preferred is revoked, never seen, silent or unknown', async () => {
    expect(await admits(failover('01M6YSNJ0000000000000CPAR1', [me]))).toBe(1);
    expect(await admits(failover('01M6YSNJ0000000000000CPAV1', [me]))).toBe(1);
    expect(await admits(failover('01M6YSNJ0000000000000CPAS1', [me]))).toBe(1);
    expect(await admits(failover('01M6YSNJ0000000000000CPAX1', [me]))).toBe(1);
  });

  it('judges silence by the policy offline_after_seconds, else the default', async () => {
    // The preferred was seen 600 s ago.
    const stale = '01M6YSNJ0000000000000CPAS1';
    expect(await admits(failover(stale, [me], { offline_after_seconds: 900 }))).toBe(0);
    expect(await admits(failover(stale, [me], { offline_after_seconds: 120 }))).toBe(1);
    expect(await admits(failover(stale, [me]), 900)).toBe(0);
    expect(await admits(failover(stale, [me]), 300)).toBe(1);
  });

  it('never admits a runner the failover policy does not name, nor an unknown mode', async () => {
    expect(await admits(failover('01M6YSNJ0000000000000CPAR1', ['01M6YSNJ0000000000000CPAV1']))).toBe(0);
    expect(await admits({ mode: 'nearest' })).toBe(0);
  });
});

describe('runnerFitsAccessSourceSql', () => {
  // ?1 hosted, ?2 isolation, ?3 capabilities, ?4 the project's access source.
  const rows = `WITH r(hosted, isolation, capabilities) AS (SELECT ?1, ?2, ?3), p(access_source) AS (SELECT ?4)`;
  const fits = (
    term: string,
    runner: { hosted: 0 | 1; isolation: string; sources?: readonly string[] },
    source: 'api_key' | 'subscription',
  ) =>
    env.DB.prepare(`${rows} SELECT (${term}) AS ok FROM r, p`)
      .bind(
        runner.hosted,
        runner.isolation,
        JSON.stringify(runner.sources === undefined ? {} : { accessSources: runner.sources }),
        source,
      )
      .first<{ ok: number }>()
      .then((row) => row?.ok ?? -1);
  const term = runnerFitsAccessSourceSql('r', 'p');

  const cases: ReadonlyArray<{
    readonly name: string;
    readonly runner: { hosted: 0 | 1; isolation: string; sources?: readonly string[] };
    readonly source: 'api_key' | 'subscription';
    readonly expected: 0 | 1;
  }> = [
    {
      name: 'subscription on a self-hosted user runner',
      runner: { hosted: 0, isolation: 'user' },
      source: 'subscription',
      expected: 1,
    },
    {
      name: 'subscription on a hosted runner (C12 row 6)',
      runner: { hosted: 1, isolation: 'container' },
      source: 'subscription',
      expected: 0,
    },
    {
      name: 'subscription on an actions-ephemeral runner',
      runner: { hosted: 0, isolation: 'actions-ephemeral' },
      source: 'subscription',
      expected: 0,
    },
    {
      name: 'api_key on a hosted runner',
      runner: { hosted: 1, isolation: 'container' },
      source: 'api_key',
      expected: 1,
    },
    {
      name: 'api_key on an actions-ephemeral runner',
      runner: { hosted: 0, isolation: 'actions-ephemeral' },
      source: 'api_key',
      expected: 1,
    },
    {
      name: 'subscription, declared subscription',
      runner: { hosted: 0, isolation: 'user', sources: ['subscription'] },
      source: 'subscription',
      expected: 1,
    },
    {
      name: 'subscription, declared api_key only',
      runner: { hosted: 0, isolation: 'user', sources: ['api_key'] },
      source: 'subscription',
      expected: 0,
    },
    {
      name: 'api_key, declared subscription only',
      runner: { hosted: 1, isolation: 'container', sources: ['subscription'] },
      source: 'api_key',
      expected: 0,
    },
    {
      name: 'api_key, declared both',
      runner: { hosted: 1, isolation: 'container', sources: ['api_key', 'subscription'] },
      source: 'api_key',
      expected: 1,
    },
    {
      name: 'api_key, declared nothing at all (empty list)',
      runner: { hosted: 0, isolation: 'user', sources: [] },
      source: 'api_key',
      expected: 0,
    },
  ];

  it.each(cases)('$name -> $expected', async ({ runner, source, expected }) => {
    expect(await fits(term, runner, source)).toBe(expected);
  });

  // #809: before the outer parentheses `NOT term` negated the C12 half only, so a runner whose declared sources rule
  // the project out did not read as unfit.
  it('composes with NOT, OR and AND as one term', async () => {
    for (const { runner, source, expected } of cases) {
      expect(await fits(`NOT ${term}`, runner, source)).toBe(1 - expected);
      expect(await fits(`0 OR ${term}`, runner, source)).toBe(expected);
      expect(await fits(`${term} OR 0`, runner, source)).toBe(expected);
      expect(await fits(`1 AND ${term}`, runner, source)).toBe(expected);
      expect(await fits(`${term} AND 0`, runner, source)).toBe(0);
      expect(await fits(`${term} = 1`, runner, source)).toBe(expected);
    }
  });
});

describe('runnerScopeCoversSql', () => {
  // ?1 scope, ?2 allowed_projects, ?3 the slug.
  const covers = (scope: 'all' | 'selected', list: readonly string[], slug: string) =>
    env.DB.prepare(
      `WITH r(project_scope, allowed_projects) AS (SELECT ?1, ?2) SELECT (${runnerScopeCoversSql('r', '?3')}) AS ok FROM r`,
    )
      .bind(scope, JSON.stringify(list), slug)
      .first<{ ok: number }>()
      .then((row) => row?.ok ?? -1);

  it('covers every slug under `all`, whatever the list holds', async () => {
    expect(await covers('all', [], 'cov-a')).toBe(1);
    expect(await covers('all', ['cov-b'], 'cov-a')).toBe(1);
  });

  it('covers under `selected` only the listed slugs', async () => {
    expect(await covers('selected', ['cov-a', 'cov-b'], 'cov-a')).toBe(1);
    expect(await covers('selected', ['cov-b'], 'cov-a')).toBe(0);
    expect(await covers('selected', [], 'cov-a')).toBe(0);
  });

  it('ignores D3: it reads neither owners nor the enroller', () => {
    const term = runnerScopeCoversSql('r', '?3');
    expect(term).not.toContain('account_members');
    expect(term).not.toContain('enrolled_by');
  });
});
