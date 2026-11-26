import { env } from 'cloudflare:test';
import type { NewAuditEvent } from '../accounts/audit.repo';
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
const hash = (seed: string): string =>
  seed
    .repeat(64)
    .slice(0, 64)
    .replace(/[^0-9a-f]/g, '0');

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
  projectScope: 'selected',
  allowedProjects: ['p1'],
  enrolledBy: 'owner-1',
  version: '0.1.0',
  at: T0,
  ...overrides,
});

const SCOPE_AUDIT = 'runner.scope-changed' as const;
const selected = (allowedProjects: readonly string[]) => ({
  projectScope: 'selected' as const,
  allowedProjects,
});
const ALL = { projectScope: 'all' as const, allowedProjects: [] as readonly string[] };

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO accounts (id, slug, name, created_at) VALUES (?1, 'rn-a', 'A', ?2)`).bind(
      ACCOUNT_A,
      T0,
    ),
    env.DB.prepare(`INSERT INTO accounts (id, slug, name, created_at) VALUES (?1, 'rn-b', 'B', ?2)`).bind(
      ACCOUNT_B,
      T0,
    ),
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
        projectScope: 'selected',
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
        projectScope: 'selected',
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
      projectScope: 'selected',
      allowedProjects: ['p1'],
      enrolledBy: 'owner-1',
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
      {
        codeHash,
        accountId: ACCOUNT_A,
        name: 'mac',
        projectScope: 'selected',
        allowedProjects: [],
        createdBy: 'owner-1',
        at: T0,
        expiresAt: T1,
      },
      audit('enrolment-code.created'),
    );
    expect(await repo.findEnrolment(codeHash)).not.toBeNull();
    expect(await repo.withdrawEnrolment(ACCOUNT_A, codeHash, T0, audit('enrolment-code.withdrawn'))).toBe(
      true,
    );

    const late = runnerOf();
    expect(await repo.enrol(codeHash, late, { ...audit('runner.enrolled'), target: late.id })).toBe(
      'code-used',
    );

    expect(await repo.findById(late.id)).toBeNull();
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'runner.enrolled' AND target = ?1`,
      )
        .bind(late.id)
        .first<number>('n'),
    ).toBe(0);
  });

  it('writes the runner.enrolled row with the enrolment it records', async () => {
    const codeHash = hash('d');
    await repo.createEnrolment(
      {
        codeHash,
        accountId: ACCOUNT_A,
        name: 'mac',
        projectScope: 'selected',
        allowedProjects: [],
        createdBy: 'owner-1',
        at: T0,
        expiresAt: T1,
      },
      audit('enrolment-code.created'),
    );
    const runner = runnerOf();
    expect(await repo.enrol(codeHash, runner, { ...audit('runner.enrolled'), target: runner.id })).toBe('ok');
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'runner.enrolled' AND target = ?1`,
      )
        .bind(runner.id)
        .first<number>('n'),
    ).toBe(1);
  });

  // #531: the route checked the code a moment before it expired; `enrol` runs at the expiry instant itself.
  it('enrols nothing and audits nothing on a code that expires between the route check and the batch', async () => {
    const codeHash = hash('e');
    await repo.createEnrolment(
      {
        codeHash,
        accountId: ACCOUNT_A,
        name: 'mac',
        projectScope: 'selected',
        allowedProjects: [],
        createdBy: 'owner-1',
        at: T0,
        expiresAt: T1,
      },
      audit('enrolment-code.created'),
    );
    const late = runnerOf({ at: T1 });
    expect(await repo.enrol(codeHash, late, { ...audit('runner.enrolled'), target: late.id })).toBe(
      'code-used',
    );

    expect(await repo.findById(late.id)).toBeNull();
    expect(await auditRows('runner.enrolled', late.id)).toBe(0);
    expect(await repo.findEnrolment(codeHash)).toMatchObject({ usedByRunnerId: null, usedAt: null });
  });

  it('still enrols on a code one millisecond before it expires', async () => {
    const codeHash = hash('f');
    await repo.createEnrolment(
      {
        codeHash,
        accountId: ACCOUNT_A,
        name: 'mac',
        projectScope: 'selected',
        allowedProjects: [],
        createdBy: 'owner-1',
        at: T0,
        expiresAt: T1,
      },
      audit('enrolment-code.created'),
    );
    const runner = runnerOf({ at: '2026-11-10T10:00:59.999Z' });
    expect(await repo.enrol(codeHash, runner, { ...audit('runner.enrolled'), target: runner.id })).toBe('ok');
    expect(await auditRows('runner.enrolled', runner.id)).toBe(1);
  });

  it('refuses a private key member or another curve at the row', async () => {
    const codeHash = hash('b');
    await repo.createEnrolment(
      {
        codeHash,
        accountId: ACCOUNT_A,
        name: 'x',
        projectScope: 'selected',
        allowedProjects: [],
        createdBy: 'o',
        at: T0,
        expiresAt: T1,
      },
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

  it('changes the scope inside the account only', async () => {
    const runner = await enrolled();
    expect(
      await repo.setScope(ACCOUNT_B, runner.id, selected(['p9']), 'owner-1', audit(SCOPE_AUDIT, ACCOUNT_B)),
    ).toBe('unchanged');
    expect(
      await repo.setScope(ACCOUNT_A, runner.id, selected(['p2', 'p3']), 'owner-1', audit(SCOPE_AUDIT)),
    ).toBe('changed');
    expect((await repo.findById(runner.id))?.allowedProjects).toEqual(['p2', 'p3']);
  });

  // #775: `all` stores an empty list whatever the caller passed; `selected` again restores a list.
  it('switches to all and back without re-enrolment, auditing each change once', async () => {
    const runner = await enrolled();
    const changed = { ...audit(SCOPE_AUDIT), target: runner.id };
    expect(
      await repo.setScope(
        ACCOUNT_A,
        runner.id,
        { projectScope: 'all', allowedProjects: ['p1'] },
        'owner-1',
        changed,
      ),
    ).toBe('changed');
    expect(await repo.findById(runner.id)).toMatchObject({ projectScope: 'all', allowedProjects: [] });
    expect(await repo.setScope(ACCOUNT_A, runner.id, ALL, 'owner-1', changed)).toBe('unchanged');
    expect(await repo.setScope(ACCOUNT_A, runner.id, selected(['p1']), 'owner-1', changed)).toBe('changed');
    expect(await repo.findById(runner.id)).toMatchObject({
      projectScope: 'selected',
      allowedProjects: ['p1'],
    });
    expect(await auditRows(SCOPE_AUDIT, runner.id)).toBe(2);
  });

  // #795: on a runner that can serve a subscription only its enroller adds; any owner narrows; the guard is in the write.
  it('lets only the enroller add to a subscription runner, any writer narrow, and leaves an api_key runner alone', async () => {
    const ACCOUNT_C = '01M6YSNJ00000000000000RNC3';
    await env.DB.prepare(`INSERT INTO accounts (id, slug, name, created_at) VALUES (?1, 'rn-c', 'C', ?2)`)
      .bind(ACCOUNT_C, T0)
      .run();
    const addOwner = async (userId: string): Promise<void> => {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO users (id, provider, provider_user_id, login, created_at, last_seen_at) VALUES (?1, 'github', ?2, ?3, ?4, ?4)`,
        ).bind(userId, String(795000 + Number(userId.slice(-3))), `rn-${userId.slice(-3)}`, T0),
        env.DB.prepare(
          `INSERT INTO account_members (account_id, user_id, role, joined_at) VALUES (?1, ?2, 'owner', ?3)`,
        ).bind(ACCOUNT_C, userId, T0),
      ]);
    };
    await addOwner('01M6YSNJ00000000000000W001');
    const inC = (target: string) => ({ ...audit(SCOPE_AUDIT, ACCOUNT_C), target });
    const subscription = await enrolled({ accountId: ACCOUNT_C, enrolledBy: 'owner-1' });
    const legacy = await enrolled({ accountId: ACCOUNT_C, enrolledBy: null });
    const apiKey = await enrolled({
      accountId: ACCOUNT_C,
      enrolledBy: 'owner-1',
      capabilities: { local: true, maxConcurrency: 1, accessSources: ['api_key'] },
    });

    expect(
      await repo.setScope(
        ACCOUNT_C,
        subscription.id,
        selected(['p1', 'p2']),
        'owner-2',
        inC(subscription.id),
      ),
    ).toBe('enroller-only');
    expect(await repo.setScope(ACCOUNT_C, subscription.id, ALL, 'owner-2', inC(subscription.id))).toBe(
      'enroller-only',
    );
    expect(
      await repo.setScope(ACCOUNT_C, subscription.id, selected(['p1']), 'owner-2', inC(subscription.id)),
    ).toBe('unchanged');
    expect(
      await repo.setScope(
        ACCOUNT_C,
        subscription.id,
        selected(['p1', 'p2']),
        'owner-1',
        inC(subscription.id),
      ),
    ).toBe('changed');
    expect(
      await repo.setScope(ACCOUNT_C, subscription.id, selected(['p2']), 'owner-2', inC(subscription.id)),
    ).toBe('changed');
    expect(await auditRows(SCOPE_AUDIT, subscription.id)).toBe(2);
    expect(await repo.setScope(ACCOUNT_C, apiKey.id, selected(['p1', 'p9']), 'owner-2', inC(apiKey.id))).toBe(
      'changed',
    );

    // A row from before `enrolled_by`: its sole owner's to widen; with a second owner, nobody's until enrolled again.
    expect(await repo.setScope(ACCOUNT_C, legacy.id, selected(['p1', 'p2']), 'owner-2', inC(legacy.id))).toBe(
      'changed',
    );
    await addOwner('01M6YSNJ00000000000000W002');
    expect(
      await repo.setScope(ACCOUNT_C, legacy.id, selected(['p1', 'p2', 'p3']), 'owner-1', inC(legacy.id)),
    ).toBe('enroller-only');
    expect(await repo.setScope(ACCOUNT_C, legacy.id, selected(['p1']), 'owner-1', inC(legacy.id))).toBe(
      'changed',
    );
    expect((await repo.findById(legacy.id))?.allowedProjects).toEqual(['p1']);
  });

  // #824: #795 judges the declaration at write time; an entry another owner added while the runner declared `api_key`
  // only must not be served by the enroller's subscription once the runner declares one on a later claim poll.
  describe('entries another owner added before a switch to subscription', () => {
    const ACCOUNT_D = '01M6YSNJ00000000000000RND4';
    const OWNER_2 = 'owner-2';
    const inD = (target: string, actor = 'owner-1') => ({ ...audit(SCOPE_AUDIT, ACCOUNT_D), target, actor });
    const servedSlugs = async (runnerId: string): Promise<string[]> =>
      (await repo.servedProjectsOf(ACCOUNT_D, runnerId)).map((row) => row.slug);
    const nonEnrollerOf = async (runnerId: string): Promise<unknown> =>
      JSON.parse(
        (await env.DB.prepare(`SELECT non_enroller_projects FROM runners WHERE id = ?1`)
          .bind(runnerId)
          .first<string>('non_enroller_projects')) ?? 'null',
      );

    beforeAll(async () => {
      const project = (slug: string, createdBy: string) =>
        env.DB.prepare(
          `INSERT INTO projects (slug, repo, display_name, cache_epoch, added_at, account_id, created_by) VALUES (?1, ?2, ?1, 0, ?3, ?4, ?5)`,
        ).bind(slug, `acme/${slug}`, T0, ACCOUNT_D, createdBy);
      const owner = (userId: string, n: number) => [
        env.DB.prepare(
          `INSERT INTO users (id, provider, provider_user_id, login, created_at, last_seen_at) VALUES (?1, 'github', ?2, ?3, ?4, ?4)`,
        ).bind(userId, String(824000 + n), `rn-824-${String(n)}`, T0),
        env.DB.prepare(
          `INSERT INTO account_members (account_id, user_id, role, joined_at) VALUES (?1, ?2, 'owner', ?3)`,
        ).bind(ACCOUNT_D, userId, T0),
      ];
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO accounts (id, slug, name, created_at) VALUES (?1, 'rn-d', 'D', ?2)`).bind(
          ACCOUNT_D,
          T0,
        ),
        ...owner('01M6YSNJ00000000000000W824', 1),
        ...owner('01M6YSNJ00000000000000W825', 2),
        project('d824-mine', 'owner-1'),
        project('d824-theirs', OWNER_2),
      ]);
    });

    it('holds the entry back under subscription, gives it back under api_key, and lets the enroller adopt it', async () => {
      const runner = await enrolled({
        accountId: ACCOUNT_D,
        enrolledBy: 'owner-1',
        allowedProjects: ['d824-mine'],
        capabilities: { local: true, maxConcurrency: 1, accessSources: ['api_key'] },
      });
      expect(
        await repo.setScope(
          ACCOUNT_D,
          runner.id,
          selected(['d824-mine', 'd824-theirs']),
          OWNER_2,
          inD(runner.id, OWNER_2),
        ),
      ).toBe('changed');
      expect(await nonEnrollerOf(runner.id)).toEqual(['d824-theirs']);
      expect(await servedSlugs(runner.id)).toEqual(['d824-mine', 'd824-theirs']);

      // The switch the claim poll records: the entry stays listed, D3 holds it back.
      expect(await repo.setAccessSources(runner.id, ['api_key', 'subscription'])).toBe(true);
      expect((await repo.findById(runner.id))?.allowedProjects).toEqual(['d824-mine', 'd824-theirs']);
      expect(await servedSlugs(runner.id)).toEqual(['d824-mine']);
      expect(await repo.unavailableReasonOf('d824-theirs', T1)).toBe('other-owner-subscription');
      expect(await repo.setAccessSources(runner.id, ['api_key'])).toBe(true);
      expect(await servedSlugs(runner.id)).toEqual(['d824-mine', 'd824-theirs']);
      expect(await repo.setAccessSources(runner.id, ['subscription'])).toBe(true);
      expect(await servedSlugs(runner.id)).toEqual(['d824-mine']);

      // The other owner may narrow and keep the held-back entry; keeping it never makes it served.
      expect(
        await repo.setScope(ACCOUNT_D, runner.id, selected(['d824-theirs']), OWNER_2, inD(runner.id, OWNER_2)),
      ).toBe('changed');
      expect(await nonEnrollerOf(runner.id)).toEqual(['d824-theirs']);
      expect(await servedSlugs(runner.id)).toEqual([]);
      // Nor may they add the enroller's project back now: it is neither served nor listed (#795).
      expect(
        await repo.setScope(
          ACCOUNT_D,
          runner.id,
          selected(['d824-theirs', 'd824-mine']),
          OWNER_2,
          inD(runner.id, OWNER_2),
        ),
      ).toBe('enroller-only');

      // The enroller keeping the entry does not adopt it; removing and adding it does.
      expect(
        await repo.setScope(
          ACCOUNT_D,
          runner.id,
          selected(['d824-theirs', 'd824-mine']),
          'owner-1',
          inD(runner.id),
        ),
      ).toBe('changed');
      expect(await nonEnrollerOf(runner.id)).toEqual(['d824-theirs']);
      expect(await servedSlugs(runner.id)).toEqual(['d824-mine']);
      expect(
        await repo.setScope(ACCOUNT_D, runner.id, selected(['d824-mine']), 'owner-1', inD(runner.id)),
      ).toBe('changed');
      expect(
        await repo.setScope(
          ACCOUNT_D,
          runner.id,
          selected(['d824-mine', 'd824-theirs']),
          'owner-1',
          inD(runner.id),
        ),
      ).toBe('changed');
      expect(await nonEnrollerOf(runner.id)).toEqual([]);
      expect(await servedSlugs(runner.id)).toEqual(['d824-mine', 'd824-theirs']);

      // `all` keeps no list, so no attribution either.
      expect(await repo.setScope(ACCOUNT_D, runner.id, ALL, 'owner-1', inD(runner.id))).toBe('changed');
      expect(await nonEnrollerOf(runner.id)).toEqual([]);
    });

    it('migration 0046 marks the entries whose latest addition another actor audited', async () => {
      const runner = await enrolled({
        accountId: ACCOUNT_D,
        enrolledBy: 'owner-1',
        allowedProjects: ['d824-mine'],
        capabilities: { local: true, maxConcurrency: 1, accessSources: ['api_key'] },
      });
      const change = (actor: string, from: readonly string[], to: readonly string[]) =>
        repo.setScope(ACCOUNT_D, runner.id, selected(to), actor, {
          ...inD(runner.id, actor),
          details: {
            from: { projectScope: 'selected', allowedProjects: from },
            to: { projectScope: 'selected', allowedProjects: to },
          },
        });
      // The other owner adds `theirs`; the enroller drops `mine` and adds it back, so its latest addition is theirs.
      expect(await change(OWNER_2, ['d824-mine'], ['d824-mine', 'd824-theirs'])).toBe('changed');
      expect(await change('owner-1', ['d824-mine', 'd824-theirs'], ['d824-theirs'])).toBe('changed');
      expect(await change('owner-1', ['d824-theirs'], ['d824-theirs', 'd824-mine'])).toBe('changed');
      // The row as it was before 0046 recorded who added what.
      await env.DB.prepare(`UPDATE runners SET non_enroller_projects = '[]' WHERE id = ?1`).bind(runner.id).run();

      const backfill = env.TEST_MIGRATIONS.find((m) => m.name.startsWith('0046_'))?.queries.find((query) =>
        query.trimStart().startsWith('UPDATE runners'),
      );
      if (backfill === undefined) {
        throw new Error('the backfill of migration 0046 is missing');
      }
      await env.DB.prepare(backfill).run();
      expect(await nonEnrollerOf(runner.id)).toEqual(['d824-theirs']);
    });
  });

  // R-SCOPE-4: a hosted identity keeps the scope the server gave it, whatever the owner's write says.
  it('never widens a hosted runner, and a hosted enrolment declares api_key for it', async () => {
    const codeHash = hash('h1');
    await repo.createEnrolment(
      {
        codeHash,
        accountId: ACCOUNT_A,
        name: 'hosted',
        projectScope: 'all',
        allowedProjects: [],
        createdBy: 'owner-1',
        at: T0,
        expiresAt: T1,
      },
      audit('enrolment-code.created'),
    );
    const hosted = runnerOf({
      projectScope: 'all',
      allowedProjects: [],
      capabilities: { local: false, maxConcurrency: 1, accessSources: ['subscription'] },
    });
    expect(await repo.enrolHosted(codeHash, hosted, audit('runner.enrolled'))).toBe('ok');
    expect(await repo.findById(hosted.id)).toMatchObject({
      hosted: true,
      projectScope: 'selected',
      allowedProjects: [],
      capabilities: { local: false, maxConcurrency: 1, accessSources: ['api_key'] },
    });
    expect(
      await repo.setScope(ACCOUNT_A, hosted.id, ALL, 'owner-1', { ...audit(SCOPE_AUDIT), target: hosted.id }),
    ).toBe('unchanged');
    expect(
      await repo.setScope(ACCOUNT_A, hosted.id, selected(['p1']), 'owner-1', {
        ...audit(SCOPE_AUDIT),
        target: hosted.id,
      }),
    ).toBe('unchanged');
    expect(await auditRows(SCOPE_AUDIT, hosted.id)).toBe(0);
    expect(await repo.setAccessSources(hosted.id, ['subscription'])).toBe(false);
    expect((await repo.findById(hosted.id))?.capabilities.accessSources).toEqual(['api_key']);
  });

  // #775 (SECURITY question 7): the declaration is stored for a self-hosted runner, once per change.
  it('records a self-hosted runner’s access sources once per change, and never for a revoked one', async () => {
    const runner = await enrolled();
    expect((await repo.findById(runner.id))?.capabilities.accessSources).toBeUndefined();
    expect(await repo.setAccessSources(runner.id, ['subscription'])).toBe(true);
    expect(await repo.setAccessSources(runner.id, ['subscription'])).toBe(false);
    expect((await repo.findById(runner.id))?.capabilities).toEqual({
      local: true,
      maxConcurrency: 1,
      accessSources: ['subscription'],
    });
    expect(await repo.setAccessSources(runner.id, ['api_key', 'subscription'])).toBe(true);
    expect((await repo.findById(runner.id))?.capabilities.accessSources).toEqual(['api_key', 'subscription']);
    expect(
      await repo.revoke(ACCOUNT_A, runner.id, T1, { ...audit('runner.revoked'), target: runner.id }),
    ).toBe(true);
    expect(await repo.setAccessSources(runner.id, ['api_key'])).toBe(false);
  });

  // #533: a write that stores the list the runner already holds is no change.
  it('changes no row and audits nothing for a list that is already stored', async () => {
    const runner = await enrolled();
    const updated = { ...audit(SCOPE_AUDIT), target: runner.id };
    expect(await repo.setScope(ACCOUNT_A, runner.id, selected(['p2']), 'owner-1', updated)).toBe('changed');
    expect(await repo.setScope(ACCOUNT_A, runner.id, selected(['p2']), 'owner-1', updated)).toBe('unchanged');
    expect(await auditRows(SCOPE_AUDIT, runner.id)).toBe(1);
    expect((await repo.findById(runner.id))?.allowedProjects).toEqual(['p2']);
  });

  // #547: the comparison is set equality, not JSON text.
  it('treats a reordered or duplicated list as no change, and a real narrowing as a change', async () => {
    const runner = await enrolled();
    const updated = { ...audit(SCOPE_AUDIT), target: runner.id };
    expect(await repo.setScope(ACCOUNT_A, runner.id, selected(['p2', 'p3', 'p4']), 'owner-1', updated)).toBe(
      'changed',
    );
    expect(await repo.setScope(ACCOUNT_A, runner.id, selected(['p4', 'p2', 'p3']), 'owner-1', updated)).toBe(
      'unchanged',
    );
    expect(
      await repo.setScope(ACCOUNT_A, runner.id, selected(['p3', 'p3', 'p2', 'p4']), 'owner-1', updated),
    ).toBe('unchanged');
    expect(await auditRows(SCOPE_AUDIT, runner.id)).toBe(1);
    expect(await repo.setScope(ACCOUNT_A, runner.id, selected(['p4', 'p2']), 'owner-1', updated)).toBe(
      'changed',
    );
    expect((await repo.findById(runner.id))?.allowedProjects).toEqual(['p4', 'p2']);
    expect(await repo.setScope(ACCOUNT_A, runner.id, selected([]), 'owner-1', updated)).toBe('changed');
    expect(await repo.setScope(ACCOUNT_A, runner.id, selected([]), 'owner-1', updated)).toBe('unchanged');
    expect(await auditRows(SCOPE_AUDIT, runner.id)).toBe(3);
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

  it('audits no revoke or scope change that changed nothing', async () => {
    const runner = await enrolled();
    expect(
      await repo.revoke(ACCOUNT_B, runner.id, T1, {
        ...audit('runner.revoked', ACCOUNT_B),
        target: runner.id,
      }),
    ).toBe(false);
    expect(
      await repo.setScope(ACCOUNT_B, runner.id, selected(['p9']), 'owner-1', {
        ...audit(SCOPE_AUDIT, ACCOUNT_B),
        target: runner.id,
      }),
    ).toBe('unchanged');
    expect(await auditRows('runner.revoked', runner.id)).toBe(0);
    expect(await auditRows(SCOPE_AUDIT, runner.id)).toBe(0);

    expect(
      await repo.setScope(ACCOUNT_A, runner.id, selected(['p2']), 'owner-1', {
        ...audit(SCOPE_AUDIT),
        target: runner.id,
      }),
    ).toBe('changed');
    expect(await auditRows(SCOPE_AUDIT, runner.id)).toBe(1);
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

  // #827 (owner decision (a)): the sole owner records themselves as the enroller of a runner from before 0036.
  describe('claimEnroller', () => {
    const CLAIM = 'runner.enroller-claimed' as const;
    let accounts = 0;
    let users = 0;

    async function accountWithOwners(...owners: readonly string[]): Promise<string> {
      accounts += 1;
      const accountId = `01M6YSNJ00000000000000CE${String(accounts).padStart(2, '0')}`;
      await env.DB.prepare(`INSERT INTO accounts (id, slug, name, created_at) VALUES (?1, ?2, 'CE', ?3)`)
        .bind(accountId, `rn-ce-${String(accounts)}`, T0)
        .run();
      for (const owner of owners) {
        await addOwner(accountId, owner);
      }
      return accountId;
    }

    const seededUsers = new Set<string>();
    async function addOwner(accountId: string, userId: string): Promise<void> {
      if (!seededUsers.has(userId)) {
        seededUsers.add(userId);
        users += 1;
        await env.DB.prepare(
          `INSERT INTO users (id, provider, provider_user_id, login, created_at, last_seen_at) VALUES (?1, 'github', ?2, ?3, ?4, ?4)`,
        )
          .bind(userId, String(827000 + users), `rn-ce-${userId.slice(-3)}`, T0)
          .run();
      }
      await env.DB.prepare(
        `INSERT INTO account_members (account_id, user_id, role, joined_at) VALUES (?1, ?2, 'owner', ?3)`,
      )
        .bind(accountId, userId, T0)
        .run();
    }

    const claimAudit = (accountId: string, target: string): NewAuditEvent => ({
      ...audit(CLAIM, accountId),
      target,
    });
    const claim = (
      accountId: string,
      runnerId: string,
      userId: string | null,
      by: string = userId ?? 'access-owner',
    ) => repo.claimEnroller(accountId, runnerId, by, userId, claimAudit(accountId, runnerId));

    const U1 = '01M6YSNJ00000000000000CEA1';
    const U2 = '01M6YSNJ00000000000000CEA2';
    const U9 = '01M6YSNJ00000000000000CEA9';

    it('lets the sole owner claim a runner with no enroller once, audited once', async () => {
      const accountId = await accountWithOwners(U1);
      const legacy = await enrolled({ accountId, enrolledBy: null });
      expect(await repo.enrollerClaimableIdsOf(accountId, U1)).toEqual([legacy.id]);

      expect(await claim(accountId, legacy.id, U1)).toBe('claimed');
      expect((await repo.findById(legacy.id))?.enrolledBy).toBe(U1);
      expect(await auditRows(CLAIM, legacy.id)).toBe(1);
      expect(await repo.enrollerClaimableIdsOf(accountId, U1)).toEqual([]);

      expect(await claim(accountId, legacy.id, U1)).toBe('already-set');
      expect(await auditRows(CLAIM, legacy.id)).toBe(1);
    });

    it('lets the door owner with no user id claim while the account has at most one owner row', async () => {
      const accountId = await accountWithOwners();
      const legacy = await enrolled({ accountId, enrolledBy: null });
      expect(await claim(accountId, legacy.id, null, 'access-owner')).toBe('claimed');
      expect((await repo.findById(legacy.id))?.enrolledBy).toBe('access-owner');
    });

    it('refuses once a second owner exists, writing and auditing nothing', async () => {
      const accountId = await accountWithOwners(U1, U2);
      const legacy = await enrolled({ accountId, enrolledBy: null });
      expect(await repo.enrollerClaimableIdsOf(accountId, U1)).toEqual([]);
      for (const userId of [U1, U2, null]) {
        expect(await claim(accountId, legacy.id, userId)).toBe('not-sole-owner');
      }
      expect((await repo.findById(legacy.id))?.enrolledBy).toBeNull();
      expect(await auditRows(CLAIM, legacy.id)).toBe(0);
    });

    it('refuses a user who is not the sole owner row, as a session read before a membership change would be', async () => {
      const accountId = await accountWithOwners(U1);
      const legacy = await enrolled({ accountId, enrolledBy: null });
      expect(await claim(accountId, legacy.id, U9)).toBe('not-sole-owner');
      expect((await repo.findById(legacy.id))?.enrolledBy).toBeNull();
    });

    it('never rewrites a recorded enroller, and the 0036 trigger refuses it below the repo too', async () => {
      const accountId = await accountWithOwners(U1);
      const recorded = await enrolled({ accountId, enrolledBy: 'owner-1' });
      expect(await claim(accountId, recorded.id, U1)).toBe('already-set');
      expect((await repo.findById(recorded.id))?.enrolledBy).toBe('owner-1');
      expect(await auditRows(CLAIM, recorded.id)).toBe(0);
      await expect(
        env.DB.prepare(`UPDATE runners SET enrolled_by = ?2 WHERE id = ?1`).bind(recorded.id, U1).run(),
      ).rejects.toThrow(/keep their identity/);
    });

    it('answers revoked, fixed and not-found for a revoked, a hosted and another account’s runner', async () => {
      const accountId = await accountWithOwners(U1);
      const revoked = await enrolled({ accountId, enrolledBy: null });
      expect(
        await repo.revoke(accountId, revoked.id, T1, {
          ...audit('runner.revoked', accountId),
          target: revoked.id,
        }),
      ).toBe(true);
      expect(await claim(accountId, revoked.id, U1)).toBe('revoked');

      const codeHash = hash('ce');
      await repo.createEnrolment(
        {
          codeHash,
          accountId,
          name: 'hosted',
          projectScope: 'selected',
          allowedProjects: [],
          createdBy: 'owner-1',
          at: T0,
          expiresAt: T1,
        },
        audit('enrolment-code.created', accountId),
      );
      const hosted = runnerOf({ accountId, enrolledBy: null, allowedProjects: [] });
      expect(await repo.enrolHosted(codeHash, hosted, audit('runner.enrolled', accountId))).toBe('ok');
      expect(await claim(accountId, hosted.id, U1)).toBe('fixed');

      const other = await accountWithOwners(U2);
      const theirs = await enrolled({ accountId: other, enrolledBy: null });
      expect(await claim(accountId, theirs.id, U1)).toBe('not-found');
      expect((await repo.findById(theirs.id))?.enrolledBy).toBeNull();
      expect(await repo.enrollerClaimableIdsOf(accountId, U1)).toEqual([]);
      for (const id of [revoked.id, hosted.id, theirs.id]) {
        expect(await auditRows(CLAIM, id)).toBe(0);
      }
    });

    it('judges the owners inside the write: an owner who joins after the caller looked is refused', async () => {
      const accountId = await accountWithOwners(U1);
      const legacy = await enrolled({ accountId, enrolledBy: null });
      expect(await repo.enrollerClaimableIdsOf(accountId, U1)).toEqual([legacy.id]);
      await addOwner(accountId, U2);
      expect(await claim(accountId, legacy.id, U1)).toBe('not-sole-owner');
      expect((await repo.findById(legacy.id))?.enrolledBy).toBeNull();
    });

    it('lets one of two concurrent claims win, with one audit row', async () => {
      const accountId = await accountWithOwners(U1);
      const legacy = await enrolled({ accountId, enrolledBy: null });
      const outcomes = await Promise.all([claim(accountId, legacy.id, U1), claim(accountId, legacy.id, U1)]);
      expect([...outcomes].sort()).toEqual(['already-set', 'claimed']);
      expect(await auditRows(CLAIM, legacy.id)).toBe(1);
    });

    it('never ends with a claim beside a second owner when the two race', async () => {
      const accountId = await accountWithOwners(U1);
      const legacy = await enrolled({ accountId, enrolledBy: null });
      const [, outcome] = await Promise.all([addOwner(accountId, U2), claim(accountId, legacy.id, U1)]);
      expect(['claimed', 'not-sole-owner']).toContain(outcome);
      // Either the claim committed first (it was the sole owner then) or it saw the second owner and wrote nothing.
      const expected =
        outcome === 'claimed'
          ? { enrolledBy: U1, audits: 1, again: 'already-set' }
          : { enrolledBy: null, audits: 0, again: 'not-sole-owner' };
      expect({
        enrolledBy: (await repo.findById(legacy.id))?.enrolledBy,
        audits: await auditRows(CLAIM, legacy.id),
        again: await claim(accountId, legacy.id, U1),
      }).toEqual(expected);
    });
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

  // #571: the runner's own pause, written inside its account only, audited once per change.
  describe('pause and resume', () => {
    const UNTIL = '2026-11-10T12:00:00.000Z';

    it('pauses inside the account, audits once per change, and resume clears it', async () => {
      const runner = await enrolled();
      const pauseAudit = { ...audit('runner.paused'), target: runner.id };
      expect(
        await repo.pause(ACCOUNT_A, runner.id, { reason: 'usage-limit', until: UNTIL }, pauseAudit),
      ).toBe(true);
      expect((await repo.findById(runner.id))?.pause).toEqual({ reason: 'usage-limit', until: UNTIL });
      // The same pause again (a restart mirroring state.json) changes nothing and audits nothing.
      expect(
        await repo.pause(ACCOUNT_A, runner.id, { reason: 'usage-limit', until: UNTIL }, pauseAudit),
      ).toBe(false);
      expect(await auditRows('runner.paused', runner.id)).toBe(1);
      expect(await repo.pause(ACCOUNT_A, runner.id, { reason: 'rate-limit', until: UNTIL }, pauseAudit)).toBe(
        true,
      );
      expect(await auditRows('runner.paused', runner.id)).toBe(2);

      const resumeAudit = { ...audit('runner.resumed'), target: runner.id };
      expect(await repo.resume(ACCOUNT_A, runner.id, resumeAudit)).toBe(true);
      expect((await repo.findById(runner.id))?.pause).toBeNull();
      expect(await repo.resume(ACCOUNT_A, runner.id, resumeAudit)).toBe(false);
      expect(await auditRows('runner.resumed', runner.id)).toBe(1);
    });

    it('never pauses or resumes another account’s runner, nor a revoked one', async () => {
      const theirs = await enrolled({ accountId: ACCOUNT_B });
      expect(
        await repo.pause(
          ACCOUNT_A,
          theirs.id,
          { reason: 'manual', until: UNTIL },
          { ...audit('runner.paused'), target: theirs.id },
        ),
      ).toBe(false);
      expect((await repo.findById(theirs.id))?.pause).toBeNull();
      expect(await auditRows('runner.paused', theirs.id)).toBe(0);

      expect(
        await repo.pause(
          ACCOUNT_B,
          theirs.id,
          { reason: 'manual', until: UNTIL },
          { ...audit('runner.paused', ACCOUNT_B), target: theirs.id },
        ),
      ).toBe(true);
      expect(await repo.resume(ACCOUNT_A, theirs.id, { ...audit('runner.resumed'), target: theirs.id })).toBe(
        false,
      );
      expect((await repo.findById(theirs.id))?.pause).toEqual({ reason: 'manual', until: UNTIL });

      const revoked = await enrolled();
      await repo.revoke(ACCOUNT_A, revoked.id, T1, { ...audit('runner.revoked'), target: revoked.id });
      expect(
        await repo.pause(
          ACCOUNT_A,
          revoked.id,
          { reason: 'manual', until: UNTIL },
          { ...audit('runner.paused'), target: revoked.id },
        ),
      ).toBe(false);
    });

    it('refuses at the row a reason without a time, a time without a reason, an unknown reason or a local time', async () => {
      const runner = await enrolled();
      const write = (until: string | null, reason: string | null): Promise<unknown> =>
        env.DB.prepare(`UPDATE runners SET paused_until = ?2, pause_reason = ?3 WHERE id = ?1`)
          .bind(runner.id, until, reason)
          .run();
      await expect(write(null, 'manual')).rejects.toThrow(/CHECK/);
      await expect(write(UNTIL, null)).rejects.toThrow(/CHECK/);
      await expect(write(UNTIL, 'tired')).rejects.toThrow(/CHECK/);
      await expect(write('2026-11-10 12:00:00', 'manual')).rejects.toThrow(/CHECK/);
      expect((await repo.findById(runner.id))?.pause).toBeNull();
    });
  });

  it('consumes a jti once until it expires, sweeping old ones', async () => {
    const runner = await enrolled();
    expect(await repo.consumeNonce(runner.id, 'j1', '2026-11-10T10:05:00.000Z', T0)).toBe(true);
    expect(await repo.consumeNonce(runner.id, 'j1', '2026-11-10T10:05:00.000Z', T0)).toBe(false);
    // Past its expiry the row is swept on the next call and the same jti is a new token's (the clock moved on).
    expect(
      await repo.consumeNonce(runner.id, 'j1', '2026-11-10T10:12:00.000Z', '2026-11-10T10:06:00.000Z'),
    ).toBe(true);
  });

  // #707 (ADR 0009 d.3, threat model C12 row 6): the placement refusal holds inside the hosted enrolment write too.
  describe('enrolHosted', () => {
    let accounts = 0;

    async function account(defaultPolicy: string | null = null): Promise<string> {
      accounts += 1;
      const id = `01M6YSNJ000000000000HS${String(accounts).padStart(4, '0')}`;
      await env.DB.prepare(
        `INSERT INTO accounts (id, slug, name, created_at, default_runner_policy) VALUES (?1, ?2, 'H', ?3, ?4)`,
      )
        .bind(id, `rn-h${String(accounts)}`, T0, defaultPolicy)
        .run();
      return id;
    }

    async function project(
      accountId: string,
      source: 'subscription' | 'api_key',
      policy: string | null = null,
    ): Promise<void> {
      counter += 1;
      const slug = `rn-hp-${String(counter)}`;
      await env.DB.prepare(
        `INSERT INTO projects (slug, repo, display_name, cache_epoch, added_at, account_id, runner_policy, access_source)
         VALUES (?1, ?2, ?1, 0, ?3, ?4, ?5, ?6)`,
      )
        .bind(slug, `acme/${slug}`, T0, accountId, policy, source)
        .run();
    }

    async function code(accountId: string): Promise<string> {
      counter += 1;
      const codeHash = String(counter).padStart(64, 'e');
      await repo.createEnrolment(
        {
          codeHash,
          accountId,
          name: 'hosted',
          projectScope: 'selected',
          allowedProjects: [],
          createdBy: 'owner-1',
          at: T0,
          expiresAt: T1,
        },
        audit('enrolment-code.created', accountId),
      );
      return codeHash;
    }

    async function enrolHosted(accountId: string, codeHash: string, id: string = ulid()) {
      const runner = runnerOf({ id, accountId, isolation: 'container' });
      const outcome = await repo.enrolHosted(codeHash, runner, {
        ...audit('runner.enrolled', accountId),
        target: runner.id,
      });
      return { outcome, runner };
    }

    it('refuses while a subscription project’s placement is any or unset, writing nothing', async () => {
      for (const policy of [null, JSON.stringify({ mode: 'any' })]) {
        const accountId = await account();
        await project(accountId, 'subscription', policy);
        const codeHash = await code(accountId);
        const { outcome, runner } = await enrolHosted(accountId, codeHash);
        expect(outcome).toBe('access-source-hosted');
        expect(await repo.findById(runner.id)).toBeNull();
        expect((await repo.findEnrolment(codeHash))?.usedByRunnerId).toBeNull();
        expect(await auditRows('runner.enrolled', runner.id)).toBe(0);
      }
    });

    it('refuses through the account default a subscription project falls back to', async () => {
      const accountId = await account(JSON.stringify({ mode: 'any' }));
      // The project's own pin to another runner holds; the second project falls back to `any`.
      await project(accountId, 'subscription', JSON.stringify({ mode: 'pinned', runner: 'mac-1' }));
      await project(accountId, 'subscription');
      expect((await enrolHosted(accountId, await code(accountId))).outcome).toBe('access-source-hosted');
    });

    it('refuses a placement that names the new runner by id, pinned or in a failover', async () => {
      const policies = [
        (id: string) => ({ mode: 'pinned', runner: id }),
        (id: string) => ({ mode: 'failover', preferred: 'mac-1', fallback: [id] }),
        (id: string) => ({ mode: 'failover', preferred: id, fallback: [] }),
      ];
      for (const policy of policies) {
        const id = ulid();
        const accountId = await account();
        await project(accountId, 'subscription', JSON.stringify(policy(id)));
        expect((await enrolHosted(accountId, await code(accountId), id)).outcome).toBe(
          'access-source-hosted',
        );
      }
    });

    it('enrols a hosted runner when no subscription project would admit it', async () => {
      const accountId = await account(JSON.stringify({ mode: 'pinned', runner: 'mac-1' }));
      await project(accountId, 'subscription');
      await project(
        accountId,
        'subscription',
        JSON.stringify({ mode: 'failover', preferred: 'mac-1', fallback: ['mac-2'] }),
      );
      await project(accountId, 'api_key', JSON.stringify({ mode: 'any' }));
      // Another account's subscription project is not this enrolment's business.
      await project(await account(), 'subscription');
      const codeHash = await code(accountId);
      const { outcome, runner } = await enrolHosted(accountId, codeHash);
      expect(outcome).toBe('ok');
      expect(await repo.findById(runner.id)).toMatchObject({ accountId, hosted: true });
      expect((await repo.findEnrolment(codeHash))?.usedByRunnerId).toBe(runner.id);
      expect(await auditRows('runner.enrolled', runner.id)).toBe(1);
    });

    it('answers code-used for a used code, whatever the placement says', async () => {
      const accountId = await account();
      const codeHash = await code(accountId);
      expect((await enrolHosted(accountId, codeHash)).outcome).toBe('ok');
      expect((await enrolHosted(accountId, codeHash)).outcome).toBe('code-used');
      await project(accountId, 'subscription');
      const { outcome, runner } = await enrolHosted(accountId, codeHash);
      expect(outcome).toBe('code-used');
      expect(await repo.findById(runner.id)).toBeNull();
    });

    it('keeps the self-hosted enrolment free of the hosted refusal', async () => {
      const accountId = await account();
      await project(accountId, 'subscription');
      const codeHash = await code(accountId);
      const runner = runnerOf({ accountId });
      expect(
        await repo.enrol(codeHash, runner, { ...audit('runner.enrolled', accountId), target: runner.id }),
      ).toBe('ok');
      expect((await repo.findById(runner.id))?.hosted).toBe(false);
    });
  });
});
