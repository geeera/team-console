import { env } from 'cloudflare:test';
import { OWNER_ACCOUNT_ID } from '@shared/contracts';
import { AuditRepo } from './audit.repo';
import { InstallationsRepo } from './installations.repo';

const OTHER = '01M6YSNJ00000000000000KN02';
const T0 = '2026-11-10T10:00:00.000Z';

beforeAll(async () => {
  await env.DB.prepare(
    `INSERT INTO accounts (id, slug, name, created_at) VALUES (?1, 'other-inst', 'Other', ?2)`,
  )
    .bind(OTHER, T0)
    .run();
});

describe('InstallationsRepo.link (ADR 0008 decision 4)', () => {
  const repo = new InstallationsRepo(env.DB);
  const link = (installationId: string, accountId = OWNER_ACCOUNT_ID) => ({
    accountId,
    provider: 'github' as const,
    installationId,
    accountLogin: 'acme',
    linkedByUserId: null,
    at: T0,
  });

  it('links an installation to the account with its audit row, once', async () => {
    await expect(repo.link(link('5001'))).resolves.toBe('linked');
    await expect(repo.findLinked('github', '5001')).resolves.toMatchObject({
      accountId: OWNER_ACCOUNT_ID,
      installationId: '5001',
      accountLogin: 'acme',
    });
    const audit = await new AuditRepo(env.DB).listForAccount(OWNER_ACCOUNT_ID, null, 10);
    expect(audit.events.map((event) => [event.kind, event.target, event.actorKind])).toContainEqual([
      'installation.linked',
      'github:5001',
      'system',
    ]);

    await expect(repo.link(link('5001'))).resolves.toBe('already-linked');
    expect(
      (await repo.listLinked(OWNER_ACCOUNT_ID)).filter((row) => row.installationId === '5001'),
    ).toHaveLength(1);
  });

  it('refuses to link an installation that is live under another account, writing nothing', async () => {
    await repo.link(link('5002', OTHER));
    const before = await new AuditRepo(env.DB).listForAccount(OWNER_ACCOUNT_ID, null, 100);

    await expect(repo.link(link('5002'))).resolves.toBe('linked-elsewhere');

    await expect(repo.findLinked('github', '5002')).resolves.toMatchObject({ accountId: OTHER });
    const after = await new AuditRepo(env.DB).listForAccount(OWNER_ACCOUNT_ID, null, 100);
    expect(after.events).toHaveLength(before.events.length);
  });

  it('reads the winner back when the insert itself loses the race', async () => {
    // The 0018 trigger refuses a second live row for the same installation; the repo answers whose it is.
    await env.DB.prepare(
      `INSERT INTO installations (account_id, provider, installation_id, account_login, linked_at)
       VALUES (?1, 'github', '5003', 'acme', ?2)`,
    )
      .bind(OTHER, T0)
      .run();
    await expect(
      env.DB.prepare(
        `INSERT INTO installations (account_id, provider, installation_id, account_login, linked_at)
         VALUES (?1, 'github', '5003', 'acme', ?2)`,
      )
        .bind(OWNER_ACCOUNT_ID, T0)
        .run(),
    ).rejects.toThrow(/never re-pointed/);
    await expect(repo.link(link('5003'))).resolves.toBe('linked-elsewhere');
  });
});
