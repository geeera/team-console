import { env } from 'cloudflare:test';
import { OwnerConnectionsRepo, type NewOwnerConnection } from './owner-connections.repo';

const ENV = 'dev';

function connection(overrides: Partial<NewOwnerConnection> = {}): NewOwnerConnection {
  return {
    environment: ENV,
    login: 'geeera',
    userId: 1001,
    accessTokenEnc: 'aa01',
    refreshTokenEnc: 'bb01',
    accessExpiresAt: 2_000,
    refreshExpiresAt: 9_000,
    keyId: 'deadbeef',
    now: '2026-09-30T10:00:00.000Z',
    ...overrides,
  };
}

describe('OwnerConnectionsRepo', () => {
  const repo = new OwnerConnectionsRepo(env.DB);

  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM owner_connections').run();
  });

  it('finds nothing before a connection', async () => {
    await expect(repo.find(ENV)).resolves.toBeNull();
  });

  it('stores a connection at version 1 without a lease', async () => {
    await repo.connect(connection());

    await expect(repo.find(ENV)).resolves.toEqual({
      environment: ENV,
      login: 'geeera',
      user_id: 1001,
      access_token_enc: 'aa01',
      refresh_token_enc: 'bb01',
      access_expires_at: 2_000,
      refresh_expires_at: 9_000,
      key_id: 'deadbeef',
      version: 1,
      refreshing_until: null,
      connected_at: '2026-09-30T10:00:00.000Z',
      updated_at: '2026-09-30T10:00:00.000Z',
    });
  });

  it('replaces a previous connection, moving the version on and dropping its lease', async () => {
    await repo.connect(connection());
    await repo.takeRefreshLease(ENV, 1, 100, 60);

    await repo.connect(connection({ accessTokenEnc: 'aa02', now: '2026-09-30T11:00:00.000Z' }));

    await expect(repo.find(ENV)).resolves.toMatchObject({
      access_token_enc: 'aa02',
      version: 2,
      refreshing_until: null,
      connected_at: '2026-09-30T11:00:00.000Z',
    });
  });

  it('grants the refresh lease to one caller only, and again once it has expired', async () => {
    await repo.connect(connection());

    const [first, second] = await Promise.all([
      repo.takeRefreshLease(ENV, 1, 100, 60),
      repo.takeRefreshLease(ENV, 1, 100, 60),
    ]);
    expect([first, second].sort()).toEqual([false, true]);
    await expect(repo.takeRefreshLease(ENV, 1, 159, 60)).resolves.toBe(false);
    await expect(repo.takeRefreshLease(ENV, 1, 161, 60)).resolves.toBe(true);
    await expect(repo.find(ENV)).resolves.toMatchObject({ refreshing_until: 221 });
  });

  it('refuses the lease for a version that moved on', async () => {
    await repo.connect(connection());
    await repo.connect(connection());

    await expect(repo.takeRefreshLease(ENV, 1, 100, 60)).resolves.toBe(false);
  });

  it('stores a refreshed pair over its version, bumps it and clears the lease', async () => {
    await repo.connect(connection());
    await repo.takeRefreshLease(ENV, 1, 100, 60);
    const pair = {
      accessTokenEnc: 'aa02',
      refreshTokenEnc: 'bb02',
      accessExpiresAt: 3_000,
      refreshExpiresAt: 10_000,
      keyId: 'deadbeef',
    };

    await expect(repo.storeRefreshed(ENV, 1, pair, '2026-09-30T12:00:00.000Z')).resolves.toBe(true);
    await expect(repo.storeRefreshed(ENV, 1, pair, '2026-09-30T12:00:00.000Z')).resolves.toBe(false);
    await expect(repo.find(ENV)).resolves.toMatchObject({
      access_token_enc: 'aa02',
      refresh_token_enc: 'bb02',
      access_expires_at: 3_000,
      refresh_expires_at: 10_000,
      version: 2,
      refreshing_until: null,
      connected_at: '2026-09-30T10:00:00.000Z',
      updated_at: '2026-09-30T12:00:00.000Z',
    });
  });

  it('deletes at a version only while the row is still at it', async () => {
    await repo.connect(connection());
    await repo.connect(connection());

    await expect(repo.deleteAtVersion(ENV, 1)).resolves.toBe(false);
    await expect(repo.find(ENV)).resolves.not.toBeNull();
    await expect(repo.deleteAtVersion(ENV, 2)).resolves.toBe(true);
    await expect(repo.find(ENV)).resolves.toBeNull();
  });

  it('deletes whatever the version, and only its own environment', async () => {
    await repo.connect(connection());
    await repo.connect(connection({ environment: 'stage' }));

    await expect(repo.delete(ENV)).resolves.toBe(true);
    await expect(repo.delete(ENV)).resolves.toBe(false);
    await expect(repo.find('stage')).resolves.not.toBeNull();
  });
});
