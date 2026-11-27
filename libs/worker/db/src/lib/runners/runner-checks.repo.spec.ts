import { env } from 'cloudflare:test';
import { RunnerChecksRepo, type RunnerCheckRequester } from './runner-checks.repo';
import { RunnersRepo } from './runners.repo';

// #1059 (security note S1, S8, S10, S12; tests 6, 9, 12, 13): the repository's own terms, past the routes.

const OWNER: RunnerCheckRequester = { actorKind: 'user', actor: 'owner', ipCountry: null };
const CAPS = { perRunner: 10, perAccount: 30 };
let counter = 0;

function ulid(prefix: string): string {
  counter += 1;
  return `01M6YSNJ00000000${prefix}${String(counter).padStart(7, '0')}`;
}

async function seedRunner(
  options: { capabilities?: Record<string, unknown>; account?: string } = {},
): Promise<{ account: string; runner: string }> {
  const account = options.account ?? ulid('RCA');
  if (options.account === undefined) {
    await env.DB.prepare(`INSERT INTO accounts (id, slug, name, created_at) VALUES (?1, ?2, 'A', ?3)`)
      .bind(account, `rc-${String(counter)}`, new Date().toISOString())
      .run();
  }
  const runner = ulid('RCR');
  await env.DB.prepare(
    `INSERT INTO runners (id, account_id, name, public_key_jwk, capabilities, isolation, version, enrolled_at)
     VALUES (?1, ?2, 'mac', ?3, ?4, 'user', '0.1.0', ?5)`,
  )
    .bind(
      runner,
      account,
      JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: String(counter).padStart(43, 'k') }),
      JSON.stringify(options.capabilities ?? { local: true, maxConcurrency: 1, checks: ['smoke'] }),
      new Date().toISOString(),
    )
    .run();
  return { account, runner };
}

const ago = (seconds: number): string => new Date(Date.now() - seconds * 1000).toISOString();

describe('RunnerChecksRepo', () => {
  const repo = new RunnerChecksRepo(env.DB);

  it('maps the unique-index race to the live check, writing nothing, never an error (S12)', async () => {
    const { account, runner } = await seedRunner();
    const first = await repo.create(
      { id: ulid('RCK'), accountId: account, runnerId: runner, kind: 'smoke', at: ago(1) },
      OWNER,
      CAPS,
    );
    expect(first.kind).toBe('created');
    // A second request that read "no live check" before the first committed: its INSERT meets the index.
    const second = await repo.create(
      { id: ulid('RCK'), accountId: account, runnerId: runner, kind: 'smoke', at: ago(0) },
      OWNER,
      CAPS,
    );
    expect(second).toEqual({ kind: 'live', check: first.kind === 'created' ? first.check : null });
    const audits = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'runner.check-requested' AND target = ?1`,
    )
      .bind(runner)
      .first<{ n: number }>();
    expect(audits?.n).toBe(1);
  });

  it('refuses a runner that has not declared smoke inside the INSERT', async () => {
    const { account, runner } = await seedRunner({ capabilities: { local: true, maxConcurrency: 1 } });
    expect(
      await repo.create(
        { id: ulid('RCK'), accountId: account, runnerId: runner, kind: 'smoke', at: ago(0) },
        OWNER,
        CAPS,
      ),
    ).toEqual({ kind: 'refused' });
  });

  it('prunes the runner’s finished checks past 30 days in the enqueue batch, and never an audit row (S7, test 12)', async () => {
    const { account, runner } = await seedRunner();
    const other = await seedRunner({ account });
    const old = ulid('RCK');
    const otherOld = ulid('RCK');
    for (const [id, runnerId] of [
      [old, runner],
      [otherOld, other.runner],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO runner_checks (id, account_id, runner_id, kind, requested_by, state, claude_version, created_at, picked_at, finished_at)
         VALUES (?1, ?2, ?3, 'smoke', 'owner', 'passed', '2.1.3', ?4, ?4, ?4)`,
      )
        .bind(id, account, runnerId, ago(31 * 24 * 3600))
        .run();
      await env.DB.prepare(
        `INSERT INTO audit_events (account_id, at, actor_kind, actor, kind, target, details) VALUES (?1, ?2, 'user', 'owner', 'runner.check-requested', ?3, ?4)`,
      )
        .bind(account, ago(31 * 24 * 3600), runnerId, JSON.stringify({ checkId: id, kind: 'smoke' }))
        .run();
    }
    const auditsBefore = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE account_id = ?1`)
      .bind(account)
      .first<{ n: number }>();
    expect(
      (
        await repo.create(
          { id: ulid('RCK'), accountId: account, runnerId: runner, kind: 'smoke', at: ago(0) },
          OWNER,
          CAPS,
        )
      ).kind,
    ).toBe('created');
    const left = await env.DB.prepare(`SELECT id FROM runner_checks WHERE id IN (?1, ?2)`)
      .bind(old, otherOld)
      .all<{ id: string }>();
    expect(left.results.map((row) => row.id)).toEqual([otherOld]);
    const auditsAfter = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE account_id = ?1`)
      .bind(account)
      .first<{ n: number }>();
    expect(auditsAfter?.n).toBe((auditsBefore?.n ?? 0) + 1);
  });

  it('picks up only the runner’s own check of its own account, and never for a revoked runner (S10)', async () => {
    const { account, runner } = await seedRunner();
    const created = await repo.create(
      { id: ulid('RCK'), accountId: account, runnerId: runner, kind: 'smoke', at: ago(0) },
      OWNER,
      CAPS,
    );
    expect(created.kind).toBe('created');
    const elsewhere = await seedRunner();
    expect(await repo.pickUp(elsewhere.account, runner, ['smoke'], ago(0))).toBeNull();
    expect(await repo.pickUp(account, runner, [], ago(0))).toBeNull();
    await env.DB.prepare(`UPDATE runners SET revoked_at = ?2 WHERE id = ?1`).bind(runner, ago(0)).run();
    expect(await repo.pickUp(account, runner, ['smoke'], ago(0))).toBeNull();
  });

  it('finishes only with the runner’s own account (T2)', async () => {
    const { account, runner } = await seedRunner();
    const created = await repo.create(
      { id: ulid('RCK'), accountId: account, runnerId: runner, kind: 'smoke', at: ago(0) },
      OWNER,
      CAPS,
    );
    if (created.kind !== 'created') {
      throw new Error('not created');
    }
    expect(await repo.pickUp(account, runner, ['smoke'], ago(0))).toMatchObject({ id: created.check.id });
    const input = { result: 'passed', claudeVersion: '2.1.3', durationMs: 5 } as const;
    expect(await repo.finish({ ...created.check, accountId: ulid('RCA') }, input, ago(0), null)).toBe(false);
    expect(await repo.finish({ ...created.check, runnerId: ulid('RCR') }, input, ago(0), null)).toBe(false);
    expect(await repo.finish(created.check, input, ago(0), null)).toBe(true);
    expect(await repo.finish(created.check, input, ago(0), null)).toBe(false);
  });
});

describe('RunnersRepo.setChecks (S1)', () => {
  const runners = new RunnersRepo(env.DB);

  it('json_sets $.checks alone, only when it changed, and never on a hosted or ephemeral identity', async () => {
    const { runner } = await seedRunner({
      capabilities: { local: true, maxConcurrency: 2, accessSources: ['api_key'] },
    });
    expect(await runners.setChecks(runner, ['smoke'])).toBe(true);
    expect(await runners.setChecks(runner, ['smoke'])).toBe(false);
    const row = await env.DB.prepare(`SELECT capabilities FROM runners WHERE id = ?1`)
      .bind(runner)
      .first<{ capabilities: string }>();
    expect(JSON.parse(row?.capabilities ?? '{}')).toEqual({
      local: true,
      maxConcurrency: 2,
      accessSources: ['api_key'],
      checks: ['smoke'],
    });
    expect((await runners.findById(runner))?.capabilities.checks).toEqual(['smoke']);
    expect(await runners.setChecks(runner, [])).toBe(true);

    const hosted = await seedRunner();
    await env.DB.prepare(`UPDATE runners SET capabilities = '{}' WHERE id = ?1`).bind(hosted.runner).run();
    // `hosted` is identity-kept, so the hosted row is written as one.
    const hostedId = ulid('RCR');
    await env.DB.prepare(
      `INSERT INTO runners (id, account_id, name, public_key_jwk, hosted, isolation, version, enrolled_at)
       VALUES (?1, ?2, 'h', ?3, 1, 'container', '0.1.0', ?4)`,
    )
      .bind(
        hostedId,
        hosted.account,
        JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: 'h'.repeat(43) }),
        ago(0),
      )
      .run();
    expect(await runners.setChecks(hostedId, ['smoke'])).toBe(false);
    await env.DB.prepare(`UPDATE runners SET isolation = 'actions-ephemeral' WHERE id = ?1`)
      .bind(hosted.runner)
      .run();
    expect(await runners.setChecks(hosted.runner, ['smoke'])).toBe(false);
  });

  it('reads a broken stored declaration as none', async () => {
    const { runner } = await seedRunner({
      capabilities: { local: true, maxConcurrency: 1, checks: ['exec'] },
    });
    expect((await runners.findById(runner))?.capabilities.checks).toBeUndefined();
  });
});
