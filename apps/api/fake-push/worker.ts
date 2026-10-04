import { FakePushService, isFakePushOutcome, type FakePushHost } from '@worker/push/testing';

/**
 * Local only (`nx run api:fake-push`, 127.0.0.1:9997): the fake push service of `@worker/push/testing` as a Worker,
 * so subscribe → send → prune runs end to end against `wrangler dev` of the api with
 * `--var PUSH_FAKE_ORIGIN:http://127.0.0.1:9997`, and nothing ever reaches Apple, FCM or Mozilla. Controls:
 * POST /_fake/subscriptions {"host"?} makes a device and returns its subscription (keys stay here),
 * POST /_fake/next {"endpoint", "outcomes"} queues how its next deliveries end, POST /_fake/expire {"endpoint"}
 * uninstalls it (410 from now on), GET /_fake/state lists the deliveries, decrypted.
 */

const HOSTS: ReadonlySet<string> = new Set<FakePushHost>([
  'fcm.googleapis.com',
  'web.push.apple.com',
  'updates.push.services.mozilla.com',
]);

const fake = new FakePushService();

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    return isRecord(body) ? body : {};
  } catch {
    return {};
  }
}

export default {
  fetch: async (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/_fake/state') {
      return json(200, { deliveries: fake.deliveries });
    }
    if (url.pathname === '/_fake/subscriptions' && request.method === 'POST') {
      const host = (await bodyOf(request))['host'] ?? 'fcm.googleapis.com';
      if (typeof host !== 'string' || !HOSTS.has(host)) {
        return json(400, { message: `host must be one of ${[...HOSTS].join(', ')}` });
      }
      return json(201, await fake.subscribe(host as FakePushHost));
    }
    if (url.pathname === '/_fake/next' && request.method === 'POST') {
      const body = await bodyOf(request);
      const outcomes = body['outcomes'];
      if (typeof body['endpoint'] !== 'string' || !Array.isArray(outcomes) || !outcomes.every(isFakePushOutcome)) {
        return json(400, { message: 'endpoint and a list of known outcomes are required' });
      }
      fake.next(body['endpoint'], ...outcomes);
      return json(200, body);
    }
    if (url.pathname === '/_fake/expire' && request.method === 'POST') {
      const endpoint = (await bodyOf(request))['endpoint'];
      if (typeof endpoint !== 'string') {
        return json(400, { message: 'endpoint is required' });
      }
      fake.expire(endpoint);
      return json(200, { endpoint });
    }
    // `<fake>/<host><path>`, as the api's PUSH_FAKE_ORIGIN rewrite sends it.
    const [, host = '', ...rest] = url.pathname.split('/');
    if (!HOSTS.has(host)) {
      return json(404, { message: 'unknown push service host' });
    }
    return fake.handle(new Request(`https://${host}/${rest.join('/')}${url.search}`, request));
  },
} satisfies ExportedHandler;
