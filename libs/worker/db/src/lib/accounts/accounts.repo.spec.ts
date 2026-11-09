import { env } from 'cloudflare:test';
import { OWNER_ACCOUNT_ID, entitlementsOf, PLAN_ENTITLEMENTS } from '@shared/contracts';
import { AccountsRepo } from './accounts.repo';
import { InstallationsRepo } from './installations.repo';
import { UsersRepo } from './users.repo';

const T0 = '2026-11-09T10:00:00.000Z';
const ALICE = '01M6YSNJ0000000000000A11CE';
const BOB = '01M6YSNJ00000000000000B0B1';
const ACME = '01M6YSNJ00000000000000ACME';

async function seedUser(id: string, providerUserId: string, login: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO users (id, provider, provider_user_id, login, created_at, last_seen_at)
     VALUES (?1, 'github', ?2, ?3, ?4, ?4)`,
  )
    .bind(id, providerUserId, login, T0)
    .run();
}

beforeAll(async () => {
  await seedUser(ALICE, '101', 'alice');
  await seedUser(BOB, '102', 'bob');
});

describe('AccountsRepo', () => {
  const repo = new AccountsRepo(env.DB);

  it('finds the owner account migration 0018 created, with the team plan', async () => {
    const owner = await repo.findBySlug('owner');
    expect(owner).toEqual(expect.objectContaining({ id: OWNER_ACCOUNT_ID, plan: 'team', entitlements: {} }));
    expect(entitlementsOf(owner ?? { plan: 'free', entitlements: {} })).toEqual(PLAN_ENTITLEMENTS.team);
    await expect(repo.findById(OWNER_ACCOUNT_ID)).resolves.toEqual(owner);
  });

  it('answers null for an unknown account', async () => {
    await expect(repo.findById('01M6YSNJ0000000000000N0NE0')).resolves.toBeNull();
    await expect(repo.findBySlug('nobody')).resolves.toBeNull();
  });

  it('creates an account with its creator as owner and an audit row, in one batch', async () => {
    await expect(
      repo.create({ id: ACME, slug: 'acme', name: 'Acme', ownerUserId: ALICE, at: T0 }),
    ).resolves.toBe('created');

    expect(await repo.findBySlug('acme')).toEqual({
      id: ACME,
      slug: 'acme',
      name: 'Acme',
      plan: 'free',
      entitlements: {},
      createdAt: T0,
      suspendedAt: null,
    });
    await expect(repo.roleOf(ACME, ALICE)).resolves.toBe('owner');
    await expect(repo.roleOf(ACME, BOB)).resolves.toBeNull();
    expect(
      await env.DB.prepare(`SELECT actor_kind, actor, kind, target FROM audit_events WHERE account_id = ?1`)
        .bind(ACME)
        .all(),
    ).toEqual(
      expect.objectContaining({
        results: [{ actor_kind: 'user', actor: ALICE, kind: 'account.created', target: 'acme' }],
      }),
    );
  });

  it('refuses a taken slug and writes nothing', async () => {
    const id = '01M6YSNJ0000000000000TAKEN';
    await expect(repo.create({ id, slug: 'acme', name: 'Other', ownerUserId: BOB, at: T0 })).resolves.toBe(
      'slug-taken',
    );
    await expect(repo.findById(id)).resolves.toBeNull();
    await expect(repo.membershipsOf(BOB)).resolves.toEqual([]);
  });

  it.each([
    ['owner', 'slug-reserved'],
    ['admin', 'slug-reserved'],
    ['needs-you', 'slug-reserved'],
    ['Acme', 'slug-invalid'],
    ['x', 'slug-invalid'],
    ['acme-', 'slug-invalid'],
  ] as const)('refuses the slug %s as %s before any write', async (slug, result) => {
    await expect(
      repo.create({ id: '01M6YSNJ00000000000000REF0', slug, name: 'x', ownerUserId: BOB, at: T0 }),
    ).resolves.toBe(result);
    await expect(repo.findById('01M6YSNJ00000000000000REF0')).resolves.toBeNull();
  });

  it('refuses an id that is not a ULID', async () => {
    await expect(
      repo.create({ id: 'acme-2', slug: 'acme-two', name: 'x', ownerUserId: BOB, at: T0 }),
    ).rejects.toThrow(/ULID/);
  });

  it('writes nothing when the owner user does not exist', async () => {
    await expect(
      repo.create({
        id: '01M6YSNJ00000000000000GHST',
        slug: 'ghost',
        name: 'x',
        ownerUserId: '01M6YSNJ00000000000000N0NE',
        at: T0,
      }),
    ).rejects.toThrow(/FOREIGN KEY/);
    await expect(repo.findBySlug('ghost')).resolves.toBeNull();
  });

  it('lists the memberships of a user and the members of an account, owners first', async () => {
    await env.DB.prepare(
      `INSERT INTO account_members (account_id, user_id, role, invited_by, joined_at) VALUES (?1, ?2, 'member', ?3, ?4)`,
    )
      .bind(ACME, BOB, ALICE, '2026-11-09T11:00:00.000Z')
      .run();

    await expect(repo.membershipsOf(BOB)).resolves.toEqual([{ accountId: ACME, role: 'member' }]);
    await expect(repo.membershipsOf(ALICE)).resolves.toEqual([{ accountId: ACME, role: 'owner' }]);
    expect((await repo.membersOf(ACME)).map((member) => [member.login, member.role])).toEqual([
      ['alice', 'owner'],
      ['bob', 'member'],
    ]);
  });
});

describe('UsersRepo', () => {
  const repo = new UsersRepo(env.DB);

  it('finds a user by id and by the provider id, never by login', async () => {
    const alice = await repo.findById(ALICE);
    expect(alice).toEqual(
      expect.objectContaining({ provider: 'github', providerUserId: '101', login: 'alice' }),
    );
    await expect(repo.findByProviderId('github', '101')).resolves.toEqual(alice);
    await expect(repo.findByProviderId('gitlab', '101')).resolves.toBeNull();
    await expect(repo.findByProviderId('github', 'alice')).resolves.toBeNull();
  });

  it('finds a user by the linked Access identity only once it is linked', async () => {
    await expect(repo.findByAccessSubject('sub-bob')).resolves.toBeNull();
    await env.DB.prepare(`UPDATE users SET access_subject = 'sub-bob' WHERE id = ?1`).bind(BOB).run();
    await expect(repo.findByAccessSubject('sub-bob')).resolves.toEqual(expect.objectContaining({ id: BOB }));
  });
});

describe('InstallationsRepo', () => {
  const repo = new InstallationsRepo(env.DB);

  it('answers the current link of an installation and ignores unlinked rows', async () => {
    const insert = (account: string, installationId: string, linkedAt: string, unlinkedAt: string | null) =>
      env.DB.prepare(
        `INSERT INTO installations (account_id, provider, installation_id, account_login, linked_by_user_id,
           linked_at, unlinked_at)
         VALUES (?1, 'github', ?2, 'acme', ?3, ?4, ?5)`,
      )
        .bind(account, installationId, ALICE, linkedAt, unlinkedAt)
        .run();
    await insert(OWNER_ACCOUNT_ID, '500', '2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z');
    await insert(ACME, '500', '2026-11-03T00:00:00.000Z', null);
    await insert(ACME, '501', '2026-11-04T00:00:00.000Z', null);
    await insert(ACME, '502', '2026-11-05T00:00:00.000Z', '2026-11-06T00:00:00.000Z');

    await expect(repo.findLinked('github', '500')).resolves.toEqual(
      expect.objectContaining({ accountId: ACME, installationId: '500', linkedByUserId: ALICE }),
    );
    await expect(repo.findLinked('github', '502')).resolves.toBeNull();
    await expect(repo.findLinked('gitlab', '500')).resolves.toBeNull();
    expect((await repo.listLinked(ACME)).map((row) => row.installationId)).toEqual(['500', '501']);
    await expect(repo.listLinked(OWNER_ACCOUNT_ID)).resolves.toEqual([]);
  });
});
