import { env } from 'cloudflare:test';
import { PushSubscriptionsRepo, PushTestSendsRepo, type NewPushSubscription } from './push-subscriptions.repo';

const repo = (): PushSubscriptionsRepo => new PushSubscriptionsRepo(env.DB);

function device(n: number, overrides: Partial<NewPushSubscription> = {}): NewPushSubscription {
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/device-${n}`,
    p256dh: `p256dh-${n}`,
    auth: `auth-${n}`,
    userAgent: `agent ${n}`,
    ...overrides,
  };
}

function at(minute: number): string {
  return new Date(Date.UTC(2026, 9, 1, 12, minute)).toISOString();
}

describe('PushSubscriptionsRepo', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM push_subscriptions').run();
  });

  it('stores, lists and removes a subscription (round trip)', async () => {
    await expect(repo().upsert(device(1), at(0), 10)).resolves.toBe(0);
    await expect(repo().list()).resolves.toEqual([
      {
        endpoint: device(1).endpoint,
        p256dh: 'p256dh-1',
        auth: 'auth-1',
        userAgent: 'agent 1',
        createdAt: at(0),
        lastSuccessAt: null,
        failures: 0,
      },
    ]);
    await expect(repo().remove(device(1).endpoint)).resolves.toBe(true);
    await expect(repo().remove(device(1).endpoint)).resolves.toBe(false);
    await expect(repo().list()).resolves.toEqual([]);
  });

  it('refreshes the keys of a known endpoint, keeps created_at and clears failures', async () => {
    await repo().upsert(device(1), at(0), 10);
    await repo().markFailure(device(1).endpoint, 5);
    await repo().upsert(device(1, { p256dh: 'new-key', auth: 'new-auth' }), at(5), 10);

    const [row] = await repo().list();
    expect(row).toMatchObject({ p256dh: 'new-key', auth: 'new-auth', createdAt: at(0), failures: 0 });
  });

  it('keeps at most max devices, evicting the one longest without a delivery', async () => {
    for (let n = 1; n <= 3; n += 1) {
      await repo().upsert(device(n), at(n), 3);
    }
    // Device 1 is the oldest but delivered recently; device 2 has gone longest without one.
    await repo().markSuccess(device(1).endpoint, at(30));

    await expect(repo().upsert(device(4), at(40), 3)).resolves.toBe(1);
    const endpoints = (await repo().list()).map((row) => row.endpoint);
    expect(endpoints).toHaveLength(3);
    expect(endpoints).not.toContain(device(2).endpoint);
    expect(endpoints).toContain(device(4).endpoint);
  });

  it('never evicts the device being refreshed', async () => {
    for (let n = 1; n <= 3; n += 1) {
      await repo().upsert(device(n), at(n), 3);
    }
    await expect(repo().upsert(device(1), at(50), 3)).resolves.toBe(0);
    expect(await repo().list()).toHaveLength(3);
  });

  it('counts failures in a row, resets them on success, and prunes at the limit', async () => {
    await repo().upsert(device(1), at(0), 10);
    const endpoint = device(1).endpoint;

    await expect(repo().markFailure(endpoint, 5)).resolves.toBe(1);
    await expect(repo().markFailure(endpoint, 5)).resolves.toBe(2);
    await repo().markSuccess(endpoint, at(10));
    expect((await repo().list())[0]).toMatchObject({ failures: 0, lastSuccessAt: at(10) });

    for (let n = 1; n <= 4; n += 1) {
      await expect(repo().markFailure(endpoint, 5)).resolves.toBe(n);
    }
    await expect(repo().markFailure(endpoint, 5)).resolves.toBeNull();
    await expect(repo().list()).resolves.toEqual([]);
  });

  it('reports a failure on a row that is already gone as gone', async () => {
    await expect(repo().markFailure('https://fcm.googleapis.com/fcm/send/none', 5)).resolves.toBeNull();
  });

  it('refuses a max below 1', async () => {
    await expect(repo().upsert(device(1), at(0), 0)).rejects.toThrow(/positive integer/);
  });
});

describe('PushTestSendsRepo', () => {
  const testSends = (): PushTestSendsRepo => new PushTestSendsRepo(env.DB);

  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM push_test_sends').run();
  });

  it('claims once per interval and says how long to wait', async () => {
    await expect(testSends().claim(100_000, 30_000)).resolves.toEqual({ claimed: true });
    await expect(testSends().claim(110_000, 30_000)).resolves.toEqual({ claimed: false, retryAfterMs: 20_000 });
    await expect(testSends().claim(130_000, 30_000)).resolves.toEqual({ claimed: true });
  });

  it('lets only one of two simultaneous taps through', async () => {
    const claims = await Promise.all([testSends().claim(200_000, 30_000), testSends().claim(200_001, 30_000)]);
    expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
  });
});
