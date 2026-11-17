import { env } from 'cloudflare:test';
import { RUNNER_STILL_ALLOWS_SQL } from '../jobs/jobs.repo';
import { hostedRunnerAdmittedSql, runnerServesSql } from './access-source';

/**
 * #775, R-SCOPE-3 and R-SCOPE-4: the project term is `runnerServesSql`, the job-token term keeps the account equality
 * beside it, the subscription invariant (`hostedRunnerAdmittedSql`, C12 row 6) stays blind to scope and list alike,
 * and the term answers against D1 the way the claim does. The source-text half (no inline `json_each` term outside
 * `runnerServesSql`, the claim's account equality) is `tools/workspace-checks/src/runner-scope-sql.spec.ts`.
 */

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
    const runner = (id: string, scope: 'all' | 'selected', list: readonly string[], enrolledBy: string | null, sources: readonly string[] | null) =>
      env.DB
        .prepare(
          `INSERT INTO runners (id, account_id, name, public_key_jwk, capabilities, isolation, project_scope, allowed_projects, enrolled_by, version, enrolled_at)
           VALUES (?1, ?2, 'r', ?3, ?4, 'user', ?5, ?6, ?7, '0.1.0', '2026-11-17T00:00:00.000Z')`,
        )
        .bind(id, account, key, JSON.stringify(sources === null ? { local: true, maxConcurrency: 1 } : { local: true, maxConcurrency: 1, accessSources: sources }), scope, JSON.stringify(list), enrolledBy);
    const project = (slug: string, createdBy: string | null) =>
      env.DB
        .prepare(`INSERT INTO projects (slug, repo, display_name, cache_epoch, added_at, account_id, created_by) VALUES (?1, ?2, ?1, 0, '2026-11-17T00:00:00.000Z', ?3, ?4)`)
        .bind(slug, `acme/${slug}`, account, createdBy);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO accounts (id, slug, name, created_at) VALUES (?1, 'rsql', 'R', '2026-11-17T00:00:00.000Z')`).bind(account),
      project('rsql-mine', 'owner-1'),
      project('rsql-theirs', 'owner-2'),
      runner('01M6YSNJ0000000000000RSQA1', 'all', [], 'owner-1', ['subscription']),
      runner('01M6YSNJ0000000000000RSQK1', 'all', [], 'owner-1', ['api_key']),
      runner('01M6YSNJ0000000000000RSQS1', 'selected', ['rsql-theirs'], 'owner-1', ['subscription']),
    ]);
    const served = async (): Promise<string[]> => {
      const { results } = await env.DB
        .prepare(
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
      '01M6YSNJ0000000000000RSQS1:rsql-theirs',
    ]);
    // Two owners (D3): the subscription runner under `all` keeps its enroller's project only; the API-key runner and
    // the explicit selection are unchanged.
    for (const n of [1, 2]) {
      const user = `01M6YSNJ0000000000000RSQM${String(n)}`;
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO users (id, provider, provider_user_id, login, created_at, last_seen_at) VALUES (?1, 'github', ?2, ?3, '2026-11-17T00:00:00.000Z', '2026-11-17T00:00:00.000Z')`).bind(user, String(770000 + n), `rsql-${String(n)}`),
        env.DB.prepare(`INSERT INTO account_members (account_id, user_id, role, joined_at) VALUES (?1, ?2, 'owner', '2026-11-17T00:00:00.000Z')`).bind(account, user),
      ]);
    }
    expect(await served()).toEqual([
      '01M6YSNJ0000000000000RSQA1:rsql-mine',
      '01M6YSNJ0000000000000RSQK1:rsql-mine',
      '01M6YSNJ0000000000000RSQK1:rsql-theirs',
      '01M6YSNJ0000000000000RSQS1:rsql-theirs',
    ]);
  });
});
