import { env } from 'cloudflare:test';
import {
  PUSH_MAX_SUBSCRIPTIONS,
  isProblemDetails,
  problemSlugOf,
  type PushDevicesDto,
  type PushSendResultDto,
  type PushSubscriptionRequest,
} from '@shared/contracts';
import { FakePushService } from '@worker/push/testing';
import {
  SERVICE_TOKEN_ID,
  accessEnv,
  createSigningKey,
  fetchApi,
  signAccessToken,
  stubJwksServer,
  uniqueTeamDomain,
} from '../testing/access-kit';
import { localEnv } from '../testing/github-kit';
import { PUSH_MAX_BODY_BYTES } from './push';

// Every push goes to the fake push service through the route's fetch seam; no real push service is ever called.
// The VAPID pair is generated per run in vitest.config.mts; its private half is the sentinel below.

const WRITE_HEADERS = { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' };
const PRIVATE_KEY = env.VAPID_PRIVATE_KEY ?? '';
const T0 = Date.parse('2026-10-02T09:00:00.000Z');

interface Harness {
  readonly service: FakePushService;
  readonly logs: string[];
  readonly texts: string[];
  clock: number;
}

function harness(): Harness {
  return { service: new FakePushService(), logs: [], texts: [], clock: T0 };
}

async function call(
  h: Harness,
  method: 'GET' | 'PUT' | 'DELETE' | 'POST',
  path: string,
  body?: unknown,
  options: { bindings?: ReturnType<typeof localEnv>; headers?: Record<string, string>; raw?: string } = {},
): Promise<Response> {
  const payload = options.raw ?? (body === undefined ? undefined : JSON.stringify(body));
  const response = await fetchApi(`/api/v1/push${path}`, options.bindings ?? localEnv(), {
    method,
    headers: options.headers ?? (method === 'GET' ? {} : WRITE_HEADERS),
    ...(payload === undefined ? {} : { body: payload }),
    pushFetch: h.service.fetch,
    pushNow: () => h.clock,
    logSink: (line) => h.logs.push(line),
  });
  h.texts.push(await response.clone().text(), JSON.stringify([...response.headers.entries()]));
  return response;
}

async function slugOf(response: Response): Promise<string | null> {
  const body: unknown = await response.json();
  return isProblemDetails(body) ? problemSlugOf(body.type) : null;
}

async function storedEndpoints(): Promise<string[]> {
  const { results } = await env.DB.prepare('SELECT endpoint FROM push_subscriptions ORDER BY endpoint').all<{
    endpoint: string;
  }>();
  return results.map((row) => row.endpoint);
}

async function devices(h: Harness): Promise<PushDevicesDto['devices']> {
  const response = await call(h, 'GET', '/subscriptions');
  expect(response.status).toBe(200);
  return ((await response.json()) as PushDevicesDto).devices;
}

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare('DELETE FROM push_subscriptions'), env.DB.prepare('DELETE FROM push_test_sends')]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/v1/push/config', () => {
  it('answers the public key and nothing else (row 3)', async () => {
    const h = harness();
    const response = await call(h, 'GET', '/config');

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ publicKey: env.VAPID_PUBLIC_KEY });
  });

  it.each([
    ['the private key is absent', { VAPID_PRIVATE_KEY: undefined }],
    ['the public key is empty, as committed', { VAPID_PUBLIC_KEY: '' }],
    ['the subject is an e-mail', { VAPID_SUBJECT: 'mailto:owner@example.com' }],
  ])('answers 503 push-misconfigured when %s', async (_, overrides) => {
    const h = harness();
    const response = await call(h, 'GET', '/config', undefined, { bindings: localEnv(overrides) });

    expect(response.status).toBe(503);
    await expect(slugOf(response)).resolves.toBe('push-misconfigured');
  });
});

describe('subscriptions', () => {
  it('stores, lists and removes a device (round trip, row 8)', async () => {
    const h = harness();
    const device = await h.service.subscribe('web.push.apple.com');

    const stored = await call(h, 'PUT', '/subscriptions', device, {
      headers: { ...WRITE_HEADERS, 'User-Agent': `Mozilla/5.0 (iPhone)\ttxt ${'x'.repeat(300)}` },
    });
    expect(stored.status).toBe(204);

    const [listed, ...rest] = await devices(h);
    expect(rest).toEqual([]);
    expect([...(listed?.userAgent ?? '')].length).toBeLessThanOrEqual(256);
    expect(listed).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{64}$/),
      service: 'web.push.apple.com',
      userAgent: expect.stringMatching(/^Mozilla\/5\.0 \(iPhone\) txt x+…$/),
      createdAt: new Date(T0).toISOString(),
      lastSuccessAt: null,
      failures: 0,
    });
    // The endpoint is the device's capability URL: it is never sent back.
    expect(h.texts.join('\n')).not.toContain(new URL(device.endpoint).pathname);

    expect((await call(h, 'DELETE', '/subscriptions', { endpoint: device.endpoint })).status).toBe(204);
    await expect(devices(h)).resolves.toEqual([]);
    // Unsubscribing twice is fine: the browser may retry.
    expect((await call(h, 'DELETE', '/subscriptions', { endpoint: device.endpoint })).status).toBe(204);
  });

  it('removes a listed device by its id', async () => {
    const h = harness();
    const keep = await h.service.subscribe();
    const drop = await h.service.subscribe('web.push.apple.com');
    await call(h, 'PUT', '/subscriptions', keep);
    await call(h, 'PUT', '/subscriptions', drop);
    const id = (await devices(h)).find((item) => item.service === 'web.push.apple.com')?.id;

    expect((await call(h, 'DELETE', '/subscriptions', { id })).status).toBe(204);
    await expect(storedEndpoints()).resolves.toEqual([keep.endpoint]);
  });

  it.each([{}, { id: 'not-a-hash' }, { endpoint: 1 }, { endpoint: 'x', id: 'a'.repeat(64) }])(
    'refuses DELETE %j with 422',
    async (body) => {
      const response = await call(harness(), 'DELETE', '/subscriptions', body);
      expect(response.status).toBe(422);
      await expect(slugOf(response)).resolves.toBe('validation');
    },
  );

  it.each([
    'http://fcm.googleapis.com/fcm/send/x',
    'https://127.0.0.1/x',
    'https://evil.example/x',
    'https://fcm.googleapis.com:8443/x',
    'https://[::1]/x',
  ])('refuses the endpoint %s with 422 push-invalid-subscription and writes no row (row 1)', async (endpoint) => {
    const h = harness();
    const device = await h.service.subscribe();
    const response = await call(h, 'PUT', '/subscriptions', { ...device, endpoint });

    expect(response.status).toBe(422);
    await expect(slugOf(response)).resolves.toBe('push-invalid-subscription');
    await expect(storedEndpoints()).resolves.toEqual([]);
  });

  it.each([
    ['p256dh of 64 bytes', (d: PushSubscriptionRequest) => ({ ...d.keys, p256dh: d.keys.p256dh.slice(0, 85) })],
    ['auth of 12 bytes', (d: PushSubscriptionRequest) => ({ ...d.keys, auth: d.keys.auth.slice(0, 16) })],
    ['no auth', (d: PushSubscriptionRequest) => ({ p256dh: d.keys.p256dh })],
  ])('refuses %s with 422 and writes no row (row 2)', async (_, keys) => {
    const h = harness();
    const device = await h.service.subscribe();
    const response = await call(h, 'PUT', '/subscriptions', { ...device, keys: keys(device) });

    expect(response.status).toBe(422);
    await expect(slugOf(response)).resolves.toBe('push-invalid-subscription');
    await expect(storedEndpoints()).resolves.toEqual([]);
  });

  it('refuses a body over 4 KB with 413 (row 2)', async () => {
    const h = harness();
    const device = await h.service.subscribe();
    const response = await call(h, 'PUT', '/subscriptions', undefined, {
      raw: JSON.stringify({ ...device, padding: 'x'.repeat(PUSH_MAX_BODY_BYTES) }),
    });

    expect(response.status).toBe(413);
    await expect(slugOf(response)).resolves.toBe('payload-too-large');
    await expect(storedEndpoints()).resolves.toEqual([]);
  });

  it('keeps at most 10 devices: the eleventh evicts the one longest without a delivery (row 2)', async () => {
    const h = harness();
    const subscribed: PushSubscriptionRequest[] = [];
    for (let n = 0; n < PUSH_MAX_SUBSCRIPTIONS + 1; n += 1) {
      h.clock = T0 + n * 1000;
      const device = await h.service.subscribe();
      subscribed.push(device);
      expect((await call(h, 'PUT', '/subscriptions', device)).status).toBe(204);
    }

    const endpoints = await storedEndpoints();
    expect(endpoints).toHaveLength(PUSH_MAX_SUBSCRIPTIONS);
    expect(endpoints).not.toContain(subscribed[0]?.endpoint);
    expect(endpoints).toContain(subscribed[PUSH_MAX_SUBSCRIPTIONS]?.endpoint);
  });
});

describe('POST /api/v1/push/test', () => {
  it('sends the test notification to every device, opening /needs-you, and prunes a gone device', async () => {
    const h = harness();
    const iphone = await h.service.subscribe('web.push.apple.com');
    const mac = await h.service.subscribe('fcm.googleapis.com');
    const removed = await h.service.subscribe('web.push.apple.com');
    for (const device of [iphone, mac, removed]) {
      await call(h, 'PUT', '/subscriptions', device);
    }
    h.service.expire(removed.endpoint);

    const response = await call(h, 'POST', '/test', {});

    expect(response.status).toBe(200);
    expect((await response.json()) as PushSendResultDto).toEqual({ sent: 2, pruned: 1, failed: 0 });
    await expect(storedEndpoints()).resolves.toEqual([iphone.endpoint, mac.endpoint].sort());
    const delivered = h.service.deliveriesTo(iphone.endpoint)[0];
    expect(delivered?.decryptError).toBeNull();
    expect(delivered?.payload).toMatchObject({
      notification: {
        // The api specs run with ENVIRONMENT=local (#237): the title carries its prefix, the icon is local's.
        title: '[Local] Тестовое уведомление',
        icon: '/icons/local/icon-192.png',
        body: 'Работает. Нажмите, чтобы открыть «Ждут вас».',
        data: { onActionClick: { default: { operation: 'navigateLastFocusedOrOpen', url: '/needs-you' } } },
      },
    });
    expect(delivered?.vapid).toMatchObject({
      signatureValid: true,
      claims: { aud: 'https://web.push.apple.com', sub: 'https://github.com/geeera/team-console' },
    });
    const listed = await devices(h);
    expect(listed.every((device) => device.lastSuccessAt === new Date(T0).toISOString())).toBe(true);
  });

  it('sends the English copy when asked', async () => {
    const h = harness();
    const device = await h.service.subscribe();
    await call(h, 'PUT', '/subscriptions', device);

    expect((await call(h, 'POST', '/test', { language: 'en' })).status).toBe(200);
    expect(h.service.deliveriesTo(device.endpoint)[0]?.payload).toMatchObject({
      notification: { title: '[Local] Test notification', lang: 'en' },
    });
  });

  it('refuses an unknown language with 422 before sending anything', async () => {
    const h = harness();
    await call(h, 'PUT', '/subscriptions', await h.service.subscribe());

    const response = await call(h, 'POST', '/test', { language: 'de' });
    expect(response.status).toBe(422);
    expect(h.service.deliveries).toEqual([]);
  });

  it('accepts one test per 30 s: a second answers 429 with Retry-After (row 7)', async () => {
    const h = harness();
    const device = await h.service.subscribe();
    await call(h, 'PUT', '/subscriptions', device);

    expect((await call(h, 'POST', '/test')).status).toBe(200);
    h.clock = T0 + 12_000;
    const tooSoon = await call(h, 'POST', '/test');
    expect(tooSoon.status).toBe(429);
    expect(tooSoon.headers.get('Retry-After')).toBe('18');
    await expect(slugOf(tooSoon)).resolves.toBe('push-test-too-soon');
    expect(h.service.deliveries).toHaveLength(1);

    h.clock = T0 + 30_000;
    expect((await call(h, 'POST', '/test')).status).toBe(200);
    expect(h.service.deliveries).toHaveLength(2);
  });

  it('answers 503 when push is not configured, without using up the 30 s', async () => {
    const h = harness();
    await call(h, 'PUT', '/subscriptions', await h.service.subscribe());

    const refused = await call(h, 'POST', '/test', undefined, { bindings: localEnv({ VAPID_PRIVATE_KEY: '' }) });
    expect(refused.status).toBe(503);
    await expect(slugOf(refused)).resolves.toBe('push-misconfigured');
    expect((await call(h, 'POST', '/test')).status).toBe(200);
  });

  it('answers 503 when the fake push origin is not loopback on a local run', async () => {
    const h = harness();
    const response = await call(h, 'POST', '/test', undefined, {
      bindings: localEnv({ PUSH_FAKE_ORIGIN: 'https://evil.example' }),
    });
    expect(response.status).toBe(503);
  });
});

describe('the same-origin rule of #8 (row 7)', () => {
  it.each([
    ['PUT', '/subscriptions'],
    ['DELETE', '/subscriptions'],
    ['POST', '/test'],
  ] as const)('refuses a cross-site %s %s with 403 csrf and changes nothing', async (method, path) => {
    const h = harness();
    const device = await h.service.subscribe();
    const response = await call(h, method, path, device, {
      headers: { 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(403);
    await expect(slugOf(response)).resolves.toBe('csrf');
    await expect(storedEndpoints()).resolves.toEqual([]);
    expect(h.service.deliveries).toEqual([]);
  });
});

describe('the Access service identity (owner-only)', () => {
  it.each([
    ['GET', '/config'],
    ['GET', '/subscriptions'],
    ['PUT', '/subscriptions'],
    ['DELETE', '/subscriptions'],
    ['POST', '/test'],
  ] as const)('%s %s answers 403 owner-only', async (method, path) => {
    const h = harness();
    const jwks = stubJwksServer();
    const teamDomain = uniqueTeamDomain();
    const key = await createSigningKey();
    jwks.set(teamDomain, { keys: [key.publicJwk] });
    const token = await signAccessToken(key, teamDomain, {
      claims: { email: undefined, common_name: SERVICE_TOKEN_ID },
    });
    const device = await h.service.subscribe();

    const response = await call(h, method, path, method === 'GET' ? undefined : device, {
      bindings: accessEnv(teamDomain),
      headers: { ...(method === 'GET' ? {} : WRITE_HEADERS), 'Cf-Access-Jwt-Assertion': token },
    });

    expect(response.status).toBe(403);
    await expect(slugOf(response)).resolves.toBe('owner-only');
    await expect(storedEndpoints()).resolves.toEqual([]);
    expect(h.service.deliveries).toEqual([]);
  });
});

describe('the VAPID private key (row 3)', () => {
  it('appears in no response, header or log line of any push route', async () => {
    expect(PRIVATE_KEY).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const h = harness();
    const device = await h.service.subscribe();
    const gone = await h.service.subscribe('web.push.apple.com');
    h.service.next(gone.endpoint, 'gone');

    await call(h, 'GET', '/config');
    await call(h, 'PUT', '/subscriptions', device);
    await call(h, 'PUT', '/subscriptions', gone);
    await call(h, 'PUT', '/subscriptions', { ...device, endpoint: 'https://evil.example/x' });
    await call(h, 'GET', '/subscriptions');
    await call(h, 'POST', '/test');
    await call(h, 'POST', '/test');
    await call(h, 'GET', '/config', undefined, { bindings: localEnv({ VAPID_SUBJECT: '' }) });
    await call(h, 'DELETE', '/subscriptions', { endpoint: device.endpoint });

    expect(h.logs.length).toBeGreaterThan(0);
    // Push fields never overwrite the Worker's own `service` field that Workers Logs filters on.
    expect(h.logs.map((line) => (JSON.parse(line) as { service?: unknown }).service)).toEqual(
      h.logs.map(() => 'api'),
    );
    const everything = [...h.texts, ...h.logs].join('\n');
    expect(everything).not.toContain(PRIVATE_KEY);
    // The JWT carried the key's signature to the push service, never into our own output.
    expect(everything).not.toMatch(/vapid t=/);
  });
});
