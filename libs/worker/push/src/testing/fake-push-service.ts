import type { PushSubscriptionRequest } from '@shared/contracts';
import { encodeBase64Url } from '../lib/base64url';
import {
  decryptPushPayload,
  generateReceiverKeys,
  readVapidAuthorization,
  type ReceiverKeys,
} from './receiver';

/**
 * Test and local-run only: a stand-in for the push services (Apple, FCM, Mozilla, WNS). It hands out subscriptions on
 * the real hosts whose browser keys it keeps, so every delivery is decrypted and its VAPID JWT verified the way a push
 * service and a browser would. The api specs use it through `fetch`; `nx run api:fake-push` serves it as a local
 * Worker, so a push runs end to end without any real push service.
 */

/** How the next delivery to a device ends (one-shot, in order). */
export type FakePushOutcome = 'ok' | 'not-found' | 'gone' | 'rate-limited' | 'unavailable';

export const FAKE_PUSH_OUTCOMES: readonly FakePushOutcome[] = ['ok', 'not-found', 'gone', 'rate-limited', 'unavailable'];

export function isFakePushOutcome(value: unknown): value is FakePushOutcome {
  return typeof value === 'string' && (FAKE_PUSH_OUTCOMES as readonly string[]).includes(value);
}

export type FakePushHost = 'fcm.googleapis.com' | 'web.push.apple.com' | 'updates.push.services.mozilla.com';

export interface FakeDelivery {
  readonly endpoint: string;
  readonly outcome: FakePushOutcome;
  readonly headers: {
    readonly ttl: string | null;
    readonly urgency: string | null;
    readonly contentEncoding: string | null;
    readonly contentType: string | null;
  };
  /** The VAPID JWT as the push service reads it; `null` when the Authorization header is missing or malformed. */
  readonly vapid: {
    readonly header: Readonly<Record<string, unknown>>;
    readonly claims: Readonly<Record<string, unknown>>;
    readonly publicKey: string;
    readonly signatureValid: boolean;
  } | null;
  readonly bodyBytes: number;
  /** The decrypted JSON the browser would hand the service worker, or `null` with `decryptError`. */
  readonly payload: unknown;
  readonly decryptError: string | null;
  readonly at: string;
}

interface FakeDevice {
  readonly keys: ReceiverKeys;
  /** Uninstalled: every delivery answers 410 from now on. */
  expired: boolean;
  readonly queue: FakePushOutcome[];
}

const STATUS: Readonly<Record<FakePushOutcome, number>> = {
  ok: 201,
  'not-found': 404,
  gone: 410,
  'rate-limited': 429,
  unavailable: 503,
};

function pathFor(host: FakePushHost, id: string): string {
  switch (host) {
    case 'fcm.googleapis.com':
      return `/fcm/send/fake-${id}`;
    case 'web.push.apple.com':
      return `/fake-${id}`;
    case 'updates.push.services.mozilla.com':
      return `/wpush/v2/fake-${id}`;
  }
}

export class FakePushService {
  readonly deliveries: FakeDelivery[] = [];
  private readonly devices = new Map<string, FakeDevice>();

  /** `fetch` for the sender: the real push-service URL. */
  readonly fetch = async (input: string, init: RequestInit): Promise<Response> => this.handle(new Request(input, init));

  /** A new device on `host`, as `PushSubscription.toJSON()` returns it; the private key stays here. */
  async subscribe(host: FakePushHost = 'fcm.googleapis.com'): Promise<PushSubscriptionRequest> {
    const keys = await generateReceiverKeys();
    const id = encodeBase64Url(crypto.getRandomValues(new Uint8Array(12)));
    const endpoint = `https://${host}${pathFor(host, id)}`;
    this.devices.set(endpoint, { keys, expired: false, queue: [] });
    return {
      endpoint,
      expirationTime: null,
      keys: { p256dh: encodeBase64Url(keys.publicKey), auth: encodeBase64Url(keys.authSecret) },
    };
  }

  /** Queues how the next deliveries to `endpoint` end; without one a delivery succeeds. */
  next(endpoint: string, ...outcomes: FakePushOutcome[]): void {
    this.devices.get(endpoint)?.queue.push(...outcomes);
  }

  /** The app was removed from the device: the push service answers 410 for good. */
  expire(endpoint: string): void {
    const device = this.devices.get(endpoint);
    if (device !== undefined) {
      device.expired = true;
    }
  }

  deliveriesTo(endpoint: string): FakeDelivery[] {
    return this.deliveries.filter((delivery) => delivery.endpoint === endpoint);
  }

  async handle(request: Request): Promise<Response> {
    const endpoint = `${new URL(request.url).origin}${new URL(request.url).pathname}`;
    const device = this.devices.get(endpoint);
    const body = new Uint8Array(await request.arrayBuffer());
    const outcome: FakePushOutcome =
      device === undefined || device.expired ? 'gone' : (device.queue.shift() ?? 'ok');
    let payload: unknown = null;
    let decryptError: string | null = null;
    if (device !== undefined) {
      try {
        payload = JSON.parse(new TextDecoder().decode(await decryptPushPayload(body, device.keys))) as unknown;
      } catch (error: unknown) {
        decryptError = error instanceof Error ? error.message : 'unknown';
      }
    }
    this.deliveries.push({
      endpoint,
      outcome,
      headers: {
        ttl: request.headers.get('ttl'),
        urgency: request.headers.get('urgency'),
        contentEncoding: request.headers.get('content-encoding'),
        contentType: request.headers.get('content-type'),
      },
      vapid: await readVapidAuthorization(request.headers.get('authorization')).catch(() => null),
      bodyBytes: body.length,
      payload,
      decryptError,
      at: new Date().toISOString(),
    });
    return new Response(null, { status: STATUS[outcome] });
  }
}
