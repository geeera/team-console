import { env } from 'cloudflare:test';
import type { NewAuditEvent } from '../accounts/audit.repo';
import { RateLimitsRepo, rateWindowOf } from './rate-limits.repo';
import { RunnersRepo, type NewRunner } from './runners.repo';

const ACCOUNT_A = '01M6YSNJ00000000000000RNA1';
const ACCOUNT_B = '01M6YSNJ00000000000000RNB2';
const T0 = '2026-11-10T10:00:00.000Z';
const T1 = '2026-11-10T10:01:00.000Z';

let counter = 0;
const ulid = (): string => {
  counter += 1;
  return `01M6YSNJ0000000000RN${String(counter).padStart(6, '0')}`;
};
const hash = (seed: string): string => seed.repeat(64).slice(0, 64).replace(/[^0-9a-f]/g, '0');

const audit = (kind: NewAuditEvent['kind'], accountId = ACCOUNT_A): NewAuditEvent => ({
  accountId,
  at: T0,
  actorKind: 'user',
  actor: 'owner-1',
  kind,
  target: null,
});

const runnerOf = (overrides: Partial<NewRunner> = {}): NewRunner => ({
  id: ulid(),
  accountId: ACCOUNT_A,
  name: 'mac',
  publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: 'x'.repeat(43) },
  host: { os: 'darwin', arch: 'arm64', hostname: 'mac' },
  capabilities: { local: true, maxConcurrency: 1 },
  isolation: 'user',
  allowedProjects: ['p1'],
  version: '0.1.0',
  at: T0,
  ...overrides,
});

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO accounts (id, slug, name, created_at) VALUES (?1, 'rn-a', 'A', ?2)`).bind(ACCOUNT_A, T0),
    env.DB.prepare(`INSERT INTO accounts (id, slug, name, created_at) VALUES (?1, 'rn-b', 'B', ?2)`).bind(ACCOUNT_B, T0),
  ]);
});

const auditRows = (kind: NewAuditEvent['kind'], target: string): Promise<number | null> =>
  env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE kind = ?1 AND target = ?2`)
    .bind(kind, target)
    .first<number>('n');

describe('RunnersRepo', () => {
  const repo = new RunnersRepo(env.DB);

  async function enrolled(overrides: Partial<NewRunner> = {}): Promise<NewRunner> {
    const codeHash = hash(String(counter + 1));
    await repo.createEnrolment(
      {
        codeHash,
        accountId: overrides.accountId ?? ACCOUNT_A,
        name: 'mac',
        allowedProjects: ['p1'],
        createdBy: 'owner-1',
        at: T0,
        expiresAt: '2026-11-10T10:10:00.000Z',
      },
      audit('enrolment-code.created', overrides.accountId ?? ACCOUNT_A),
    );
    const runner = runnerOf(overrides);
    expect(await repo.enrol(codeHash, runner, audit('runner.enrolled', runner.accountId))).toBe('ok');
    return runner;
  }

  it('enrols a runner on a code once, and refuses the second use without writing anything', async () => {
    const codeHash = hash('a');
    await repo.createEnrolment(
      {
        codeHash,
        accountId: ACCOUNT_A,
        name: 'mac',
        allowedProjects: ['p1', 'p2'],
        createdBy: 'owner-1',
        at: T0,
        expiresAt: '2026-11-10T10:10:00.000Z',
      },
      audit('enrolment-code.created'),
    );
    const first = runnerOf();
    expect(await repo.enrol(codeHash, first, audit('runner.enrolled'))).toBe('ok');

    const second = runnerOf();
    expect(await repo.enrol(codeHash, second, audit('runner.enrolled'))).toBe('code-used');

    expect(await repo.findById(second.id)).toBeNull();
    expect((await repo.findEnrolment(codeHash))?.usedByRunnerId).toBe(first.id);
    const stored = await repo.findById(first.id);
    expect(stored).toMatchObject({
      accountId: ACCOUNT_A,
      name: 'mac',
      isolation: 'user',
      allowedProjects: ['p1'],
      hosted: false,
      lastSeenAt: null,
      suspectAt: null,
      revokedAt: null,
    });
  });

  // #522: the owner withdraws the code after the route looked it up and before `enrol` writes.
  it('writes nothing, no runner.enrolled row either, when the code is withdrawn mid-enrolment', async () => {
    const codeHash = hash('c');
    await repo.createEnrolment(
      { codeHash, accountId: ACCOUNT_A, name: 'mac', allowedProjects: [], createdBy: 'owner-1', at: T0, expiresAt: T1 },
      audit('enrolment-code.created'),
    );
    expect(await repo.findEnrolment(codeHash)).not.toBeNull();
    expect(await repo.withdrawEnrolment(ACCOUNT_A, codeHash, T0, audit('enrolment-code.withdrawn'))).toBe(true);

    const late = runnerOf();
    expect(await repo.enrol(codeHash, late, { ...audit('runner.enrolled'), target: late.id })).toBe('code-used');

    expect(await repo.findById(late.id)).toBeNull();
    expect(
      await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'runner.enrolled' AND target = ?1`)
        .bind(late.id)
        .first<number>('n'),
    ).toBe(0);
  });

  it('writes the runner.enrolled row with the enrolment it records', async () => {
    const codeHash = hash('d');
    await repo.createEnrolment(
      { codeHash, accountId: ACCOUNT_A, name: 'mac', allowedProjects: [], createdBy: 'owner-1', at: T0, expiresAt: T1 },
      audit('enrolment-code.created'),
    );
    const runner = runnerOf();
    expect(await repo.enrol(codeHash, runner, { ...audit('runner.enrolled'), target: runner.id })).toBe('ok');
    expect(
      await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'runner.enrolled' AND target = ?1`)
        .bind(runner.id)
        .first<number>('n'),
    ).toBe(1);
  });

  // #531: the route checked the code a moment before it expired; `enrol` runs at the expiry instant itself.
  it('enrols nothing and audits nothing on a code that expires between the route check and the batch', async () => {
    const codeHash = hash('e');
    await repo.createEnrolment(
      { codeHash, accountId: ACCOUNT_A, name: 'mac', allowedProjects: [], createdBy: 'owner-1', at: T0, expiresAt: T1 },
      audit('enrolment-code.created'),
    );
    const late = runnerOf({ at: T1 });
    expect(await repo.enrol(codeHash, late, { ...audit('runner.enrolled'), target: late.id })).toBe('code-used');

    expect(await repo.findById(late.id)).toBeNull();
    expect(await auditRows('runner.enrolled', late.id)).toBe(0);
    expect(await repo.findEnrolment(codeHash)).toMatchObject({ usedByRunnerId: null, usedAt: null });
  });

  it('still enrols on a code one millisecond before it expires', async () => {
    const codeHash = hash('f');
    await repo.createEnrolment(
      { codeHash, accountId: ACCOUNT_A, name: 'mac', allowedProjects: [], createdBy: 'owner-1', at: T0, expiresAt: T1 },
      audit('enrolment-code.created'),
    );
    const runner = runnerOf({ at: '2026-11-10T10:00:59.999Z' });
    expect(await repo.enrol(codeHash, runner, { ...audit('runner.enrolled'), target: runner.id })).toBe('ok');
    expect(await auditRows('runner.enrolled', runner.id)).toBe(1);
  });

  it('refuses a private key member or another curve at the row', async () => {
    const codeHash = hash('b');
    await repo.createEnrolment(
      { codeHash, accountId: ACCOUNT_A, name: 'x', allowedProjects: [], createdBy: 'o', at: T0, expiresAt: T1 },
      audit('enrolment-code.created'),
    );
    const leaked = runnerOf({
      publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: 'x'.repeat(43), d: 'secret' } as never,
    });
    await expect(repo.enrol(codeHash, leaked, audit('runner.enrolled'))).rejects.toThrow(/CHECK/);
  });

  it('reads a runner inside its account only', async () => {
    const runner = await enrolled();
    expect((await repo.findInAccount(ACCOUNT_A, runner.id))?.id).toBe(runner.id);
    expect(await repo.findInAccount(ACCOUNT_B, runner.id)).toBeNull();
    expect((await repo.listForAccount(ACCOUNT_B)).map((row) => row.id)).not.toContain(runner.id);
    expect(await repo.liveIdsOf(ACCOUNT_A)).toContain(runner.id);
  });

  it('revokes once, inside the account, and never a second time', async () => {
    const runner = await enrolled();
    expect(await repo.revoke(ACCOUNT_B, runner.id, T1, audit('runner.revoked', ACCOUNT_B))).toBe(false);
    expect(await repo.revoke(ACCOUNT_A, runner.id, T1, audit('runner.revoked'))).toBe(true);
    expect(await repo.revoke(ACCOUNT_A, runner.id, T1, audit('runner.revoked'))).toBe(false);
    expect((await repo.findById(runner.id))?.revokedAt).toBe(T1);
    expect(await repo.liveIdsOf(ACCOUNT_A)).not.toContain(runner.id);
  });

  it('changes allowed projects inside the account only', async () => {
    const runner = await enrolled();
    expect(await repo.setAllowedProjects(ACCOUNT_B, runner.id, ['p9'], audit('runner.updated', ACCOUNT_B))).toBe(
      false,
    );
    expect(await repo.setAllowedProjects(ACCOUNT_A, runner.id, ['p2', 'p3'], audit('runner.updated'))).toBe(true);
    expect((await repo.findById(runner.id))?.allowedProjects).toEqual(['p2', 'p3']);
  });

  // #531: the audit row follows the write that happened, not the call.
  it('leaves exactly one runner.revoked row for two concurrent revokes', async () => {
    const runner = await enrolled();
    const revokeAudit = { ...audit('runner.revoked'), target: runner.id };
    const outcomes = await Promise.all([
      repo.revoke(ACCOUNT_A, runner.id, T1, revokeAudit),
      repo.revoke(ACCOUNT_A, runner.id, T1, revokeAudit),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(await auditRows('runner.revoked', runner.id)).toBe(1);
  });

  it('audits no revoke or allow-list change that changed nothing', async () => {
    const runner = await enrolled();
    expect(
      await repo.revoke(ACCOUNT_B, runner.id, T1, { ...audit('runner.revoked', ACCOUNT_B), target: runner.id }),
    ).toBe(false);
    expect(
      await repo.setAllowedProjects(ACCOUNT_B, runner.id, ['p9'], {
        ...audit('runner.updated', ACCOUNT_B),
        target: runner.id,
      }),
    ).toBe(false);
    expect(await auditRows('runner.revoked', runner.id)).toBe(0);
    expect(await auditRows('runner.updated', runner.id)).toBe(0);

    expect(
      await repo.setAllowedProjects(ACCOUNT_A, runner.id, ['p2'], { ...audit('runner.updated'), target: runner.id }),
    ).toBe(true);
    expect(await auditRows('runner.updated', runner.id)).toBe(1);
  });

  it('still runs the statements passed along with a revoke', async () => {
    const runner = await enrolled();
    const nameOf = (): Promise<string | null> =>
      env.DB.prepare(`SELECT name FROM accounts WHERE id = ?1`).bind(ACCOUNT_B).first<string>('name');
    expect(
      await repo.revoke(ACCOUNT_A, runner.id, T1, { ...audit('runner.revoked'), target: runner.id }, [
        env.DB.prepare(`UPDATE accounts SET name = 'B-also' WHERE id = ?1`).bind(ACCOUNT_B),
      ]),
    ).toBe(true);
    expect(await auditRows('runner.revoked', runner.id)).toBe(1);
    expect(await nameOf()).toBe('B-also');
    await env.DB.prepare(`UPDATE accounts SET name = 'B' WHERE id = ?1`).bind(ACCOUNT_B).run();
  });

  describe('sightings (threat model C4, detection)', () => {
    const alertOf = (reason: 'new-country' | 'two-pollers'): NewAuditEvent => ({
      ...audit('runner.suspect'),
      details: { reason },
    });

    it('records presence and raises nothing on the first call or a repeat from the same place', async () => {
      const runner = await enrolled();
      const first = await repo.sight(runner.id, { at: T0, country: 'UA', ipHash: hash('1') }, alertOf);
      const again = await repo.sight(runner.id, { at: T1, country: 'UA', ipHash: hash('1') }, alertOf);
      expect(first).toEqual({ alert: null, previousCountry: null });
      expect(again).toEqual({ alert: null, previousCountry: 'UA' });
      expect(await repo.findById(runner.id)).toMatchObject({
        lastSeenAt: T1,
        lastSeenCountry: 'UA',
        seenCountries: ['UA'],
        suspectAt: null,
      });
    });

    it('marks a runner suspect on a claim from a new country, once', async () => {
      const runner = await enrolled();
      await repo.sight(runner.id, { at: T0, country: 'UA', ipHash: hash('1') }, alertOf);
      const moved = await repo.sight(
        runner.id,
        { at: '2026-11-10T11:00:00.000Z', country: 'DE', ipHash: hash('1') },
        alertOf,
      );
      expect(moved.alert).toBe('new-country');
      expect(await repo.findById(runner.id)).toMatchObject({
        suspectAt: '2026-11-10T11:00:00.000Z',
        suspectReason: 'new-country',
        seenCountries: ['UA', 'DE'],
      });
      const third = await repo.sight(
        runner.id,
        { at: '2026-11-10T12:00:00.000Z', country: 'FR', ipHash: hash('1') },
        alertOf,
      );
      expect(third.alert).toBeNull();
      const { results } = await env.DB.prepare(
        `SELECT details FROM audit_events WHERE kind = 'runner.suspect' AND account_id = ?1`,
      )
        .bind(ACCOUNT_A)
        .all<{ details: string }>();
      expect(results.map((row) => JSON.parse(row.details))).toContainEqual({ reason: 'new-country' });
    });

    it('marks a runner suspect when two source addresses use its id inside one lease window', async () => {
      const runner = await enrolled();
      await repo.sight(runner.id, { at: T0, country: 'UA', ipHash: hash('1') }, alertOf);
      const other = await repo.sight(runner.id, { at: T1, country: 'UA', ipHash: hash('2') }, alertOf);
      expect(other.alert).toBe('two-pollers');
      expect((await repo.findById(runner.id))?.suspectReason).toBe('two-pollers');
    });

    it('reads a changed address after the window as a move, not two pollers', async () => {
      const runner = await enrolled();
      await repo.sight(runner.id, { at: T0, country: 'UA', ipHash: hash('1') }, alertOf);
      const later = await repo.sight(
        runner.id,
        { at: '2026-11-10T10:06:00.000Z', country: 'UA', ipHash: hash('2') },
        alertOf,
      );
      expect(later.alert).toBeNull();
    });
  });

  it('consumes a jti once until it expires, sweeping old ones', async () => {
    const runner = await enrolled();
    expect(await repo.consumeNonce(runner.id, 'j1', '2026-11-10T10:05:00.000Z', T0)).toBe(true);
    expect(await repo.consumeNonce(runner.id, 'j1', '2026-11-10T10:05:00.000Z', T0)).toBe(false);
    // Past its expiry the row is swept on the next call and the same jti is a new token's (the clock moved on).
    expect(await repo.consumeNonce(runner.id, 'j1', '2026-11-10T10:12:00.000Z', '2026-11-10T10:06:00.000Z')).toBe(
      true,
    );
  });
});

describe('RateLimitsRepo', () => {
  const repo = new RateLimitsRepo(env.DB);

  it('counts hits inside a window and starts over in the next', async () => {
    expect(await repo.hit('k1', 'w1', 2)).toEqual({ allowed: true, count: 1 });
    expect(await repo.hit('k1', 'w1', 2)).toEqual({ allowed: true, count: 2 });
    expect(await repo.hit('k1', 'w1', 2)).toEqual({ allowed: false, count: 3 });
    expect(await repo.hit('k1', 'w2', 2)).toEqual({ allowed: true, count: 1 });
    expect(await repo.hit('k2', 'w2', 2)).toEqual({ allowed: true, count: 1 });
  });

  it('sweeps the rows of past windows on a hit (#489 review)', async () => {
    await repo.hit('old-address', '100', 5);
    await repo.hit('other-old', '100', 5);
    expect(await repo.hit('fresh', '102', 5)).toEqual({ allowed: true, count: 1 });
    const { results } = await env.DB.prepare(`SELECT key FROM rate_limits WHERE key IN ('old-address', 'other-old', 'fresh')`).all<{ key: string }>();
    expect(results.map((row) => row.key)).toEqual(['fresh']);
  });

  it('labels a window by its bucket', () => {
    expect(rateWindowOf(Date.parse(T0), 60)).toBe(String(Math.floor(Date.parse(T0) / 60_000)));
    expect(rateWindowOf(Date.parse(T0) + 59_999, 60)).toBe(rateWindowOf(Date.parse(T0), 60));
    expect(rateWindowOf(Date.parse(T0) + 60_000, 60)).not.toBe(rateWindowOf(Date.parse(T0), 60));
  });
});
