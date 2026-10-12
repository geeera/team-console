import type { PushSubscriptionRequest } from '@shared/contracts';
import { FakePushService, bytesOf } from '../testing';
import { encodeBase64Url } from './base64url';
import { questionNotification, testNotification } from './message';
import {
  PUSH_PRUNE_AFTER_FAILURES,
  PUSH_TTL_S,
  PushSender,
  type PushSubscriptionStore,
  type StoredPushSubscription,
} from './send';
import type { VapidConfig } from './vapid';

/** A VAPID pair for this run only. */
async function generateVapid(): Promise<VapidConfig> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  const point = new Uint8Array([0x04, ...bytesOf(jwk.x ?? ''), ...bytesOf(jwk.y ?? '')]);
  return { publicKey: encodeBase64Url(point), privateKey: jwk.d ?? '', subject: 'https://github.com/geeera/team-console' };
}

class MemoryStore implements PushSubscriptionStore {
  readonly rows = new Map<string, StoredPushSubscription & { failures: number; lastSuccessAt: string | null }>();

  add(subscription: PushSubscriptionRequest): void {
    this.rows.set(subscription.endpoint, {
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      failures: 0,
      lastSuccessAt: null,
    });
  }

  async list(): Promise<StoredPushSubscription[]> {
    return [...this.rows.values()];
  }

  async markSuccess(endpoint: string, at: string): Promise<void> {
    const row = this.rows.get(endpoint);
    if (row !== undefined) {
      row.failures = 0;
      row.lastSuccessAt = at;
    }
  }

  async markFailure(endpoint: string, pruneAt: number): Promise<number | null> {
    const row = this.rows.get(endpoint);
    if (row === undefined) {
      return null;
    }
    row.failures += 1;
    if (row.failures >= pruneAt) {
      this.rows.delete(endpoint);
      return null;
    }
    return row.failures;
  }

  async remove(endpoint: string): Promise<boolean> {
    return this.rows.delete(endpoint);
  }
}

describe('PushSender.sendToAll', () => {
  let vapid: VapidConfig;
  let service: FakePushService;
  let store: MemoryStore;
  const lines: { message: string; fields: unknown }[] = [];
  const logger = {
    info: (message: string, fields?: unknown) => lines.push({ message, fields }),
    warn: (message: string, fields?: unknown) => lines.push({ message, fields }),
    error: (message: string, fields?: unknown) => lines.push({ message, fields }),
  };

  beforeAll(async () => {
    vapid = await generateVapid();
  });

  beforeEach(() => {
    service = new FakePushService();
    store = new MemoryStore();
    lines.length = 0;
  });

  const sender = (): PushSender => new PushSender({ vapid, fetch: service.fetch, logger, environment: 'production' });

  it('delivers an encrypted ngsw payload the browser can decrypt, with TTL 24 h and high urgency', async () => {
    const device = await service.subscribe('web.push.apple.com');
    store.add(device);
    const message = questionNotification({
      language: 'ru',
      slug: 'storify',
      projectName: 'Storify',
      number: 42,
      issueTitle: 'Payment provider',
    });

    await expect(sender().sendToAll(store, message)).resolves.toEqual({ sent: 1, pruned: 0, failed: 0 });

    const [delivery] = service.deliveriesTo(device.endpoint);
    expect(delivery?.decryptError).toBeNull();
    expect(delivery?.payload).toEqual(message);
    expect(delivery?.headers).toEqual({
      ttl: String(PUSH_TTL_S),
      urgency: 'high',
      contentEncoding: 'aes128gcm',
      contentType: 'application/octet-stream',
    });
    expect(store.rows.get(device.endpoint)?.lastSuccessAt).not.toBeNull();
  });

  it('signs a VAPID JWT for the endpoint origin, valid at most 12 hours, with the https subject (row 4)', async () => {
    const device = await service.subscribe('fcm.googleapis.com');
    store.add(device);
    const before = Math.floor(Date.now() / 1000);

    await sender().sendToAll(store, testNotification('ru'));

    const jwt = service.deliveriesTo(device.endpoint)[0]?.vapid;
    expect(jwt?.signatureValid).toBe(true);
    expect(jwt?.publicKey).toBe(vapid.publicKey);
    expect(jwt?.header).toMatchObject({ alg: 'ES256', typ: 'JWT' });
    expect(jwt?.claims['aud']).toBe('https://fcm.googleapis.com');
    expect(jwt?.claims['sub']).toBe('https://github.com/geeera/team-console');
    const exp = jwt?.claims['exp'];
    expect(typeof exp).toBe('number');
    expect((exp as number) - before).toBeLessThanOrEqual(12 * 60 * 60);
    expect((exp as number) - before).toBeGreaterThan(0);
  });

  it('prunes only the device that answers 410 when others answer 201 and 429', async () => {
    const ok = await service.subscribe();
    const gone = await service.subscribe('web.push.apple.com');
    const limited = await service.subscribe('updates.push.services.mozilla.com');
    [ok, gone, limited].forEach((device) => store.add(device));
    service.next(gone.endpoint, 'gone');
    service.next(limited.endpoint, 'rate-limited');

    await expect(sender().sendToAll(store, testNotification('en'))).resolves.toEqual({ sent: 1, pruned: 1, failed: 1 });

    expect([...store.rows.keys()].sort()).toEqual([ok.endpoint, limited.endpoint].sort());
    expect(store.rows.get(limited.endpoint)?.failures).toBe(1);
  });

  it('prunes a device that answers 404', async () => {
    const device = await service.subscribe();
    store.add(device);
    service.next(device.endpoint, 'not-found');

    await expect(sender().sendToAll(store, testNotification('en'))).resolves.toEqual({ sent: 0, pruned: 1, failed: 0 });
    expect(store.rows.size).toBe(0);
  });

  it('prunes after 5 failures in a row, and a success in between resets the count', async () => {
    const device = await service.subscribe();
    store.add(device);
    service.next(device.endpoint, 'unavailable', 'unavailable', 'unavailable', 'unavailable', 'ok');
    for (let n = 0; n < 4; n += 1) {
      await sender().sendToAll(store, testNotification('en'));
    }
    expect(store.rows.get(device.endpoint)?.failures).toBe(4);
    await sender().sendToAll(store, testNotification('en'));
    expect(store.rows.get(device.endpoint)?.failures).toBe(0);

    service.next(device.endpoint, ...Array<'unavailable'>(PUSH_PRUNE_AFTER_FAILURES).fill('unavailable'));
    const results = [];
    for (let n = 0; n < PUSH_PRUNE_AFTER_FAILURES; n += 1) {
      results.push(await sender().sendToAll(store, testNotification('en')));
    }
    expect(results.at(-1)).toEqual({ sent: 0, pruned: 1, failed: 0 });
    expect(store.rows.size).toBe(0);
  });

  it('keeps going when one device throws (network error) and counts it as a failure', async () => {
    const broken = await service.subscribe();
    const fine = await service.subscribe('web.push.apple.com');
    store.add(broken);
    store.add(fine);
    const flaky = new PushSender({
      environment: 'production',
      vapid,
      logger,
      fetch: async (input, init) => {
        if (input === broken.endpoint) {
          throw new TypeError(`connect failed to ${input}`);
        }
        return service.fetch(input, init);
      },
    });

    await expect(flaky.sendToAll(store, testNotification('en'))).resolves.toEqual({ sent: 1, pruned: 0, failed: 1 });
    // Only the host reaches the log: the endpoint path is the device's capability URL.
    expect(JSON.stringify(lines)).not.toContain(new URL(broken.endpoint).pathname);
  });

  it('treats a redirect as a failure and never follows it', async () => {
    const device = await service.subscribe();
    store.add(device);
    const seen: RequestInit[] = [];
    const redirecting = new PushSender({
      environment: 'production',
      vapid,
      fetch: async (_, init) => {
        seen.push(init);
        return new Response(null, { status: 307, headers: { Location: 'https://evil.example/' } });
      },
    });

    await expect(redirecting.sendToAll(store, testNotification('en'))).resolves.toEqual({
      sent: 0,
      pruned: 0,
      failed: 1,
    });
    expect(seen[0]?.redirect).toBe('manual');
  });

  it('drops a stored row whose endpoint is not allowed without sending to it', async () => {
    store.rows.set('https://127.0.0.1/x', {
      endpoint: 'https://127.0.0.1/x',
      p256dh: 'x',
      auth: 'y',
      failures: 0,
      lastSuccessAt: null,
    });
    const fetched: string[] = [];
    const guarded = new PushSender({
      environment: 'production',
      vapid,
      fetch: async (input) => {
        fetched.push(input);
        return new Response(null, { status: 201 });
      },
    });

    await expect(guarded.sendToAll(store, testNotification('en'))).resolves.toEqual({ sent: 0, pruned: 1, failed: 0 });
    expect(fetched).toEqual([]);
  });

  it('marks every title and icon with a non-production environment before it encrypts (#237)', async () => {
    const device = await service.subscribe('web.push.apple.com');
    store.add(device);
    const dev = new PushSender({ vapid, fetch: service.fetch, logger, environment: 'dev' });

    await dev.sendToAll(store, testNotification('ru'));

    const [delivery] = service.deliveriesTo(device.endpoint);
    expect(delivery?.payload).toMatchObject({
      notification: { title: '[Dev] Тестовое уведомление', icon: '/icons/dev/icon-192.png' },
    });
  });

  it('logs the fan-out totals and duration without the private key', async () => {
    store.add(await service.subscribe());
    await sender().sendToAll(store, testNotification('ru'));
    expect(lines.find((line) => line.message === 'push fan-out')?.fields).toMatchObject({
      devices: 1,
      sent: 1,
      durationMs: expect.any(Number),
    });
    expect(JSON.stringify(lines)).not.toContain(vapid.privateKey);
  });
});
