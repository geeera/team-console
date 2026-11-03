/**
 * Web push (#11 server, #36 client). The browser subscribes through `SwPush`; the api Worker stores the
 * subscription and sends ngsw `notification` payloads whose tap target the Worker builds (threat model on #11).
 */

/** At most this many devices; a new one evicts the device that has gone longest without a delivery. */
export const PUSH_MAX_SUBSCRIPTIONS = 10;

/** `POST /api/v1/push/test` is accepted once per this many seconds (threat model on #11, row 7). */
export const PUSH_TEST_INTERVAL_S = 30;

/** `PUT /api/v1/push/subscriptions`: `PushSubscription.toJSON()` as the browser returns it. */
export interface PushSubscriptionRequest {
  readonly endpoint: string;
  readonly expirationTime?: number | null;
  readonly keys: {
    /** base64url, an uncompressed P-256 point (65 bytes, `0x04` first). */
    readonly p256dh: string;
    /** base64url, 16 bytes. */
    readonly auth: string;
  };
}

/** `DELETE /api/v1/push/subscriptions`: this browser's own `endpoint`, or a listed device's `id`; 204 even when gone. */
export type PushUnsubscribeRequest = { readonly endpoint: string } | { readonly id: string };

/** `GET /api/v1/push/config`: the VAPID public key (base64url) for `requestSubscription`, and nothing else. */
export interface PushConfigDto {
  readonly publicKey: string;
}

/** One device in `GET /api/v1/push/subscriptions`; the endpoint itself is never sent back. */
export interface PushDeviceDto {
  /** SHA-256 hex of the endpoint: stable, opaque, accepted by `DELETE`. */
  readonly id: string;
  /** The push service's host, e.g. `web.push.apple.com`. */
  readonly service: string;
  readonly userAgent: string | null;
  /** ISO 8601. */
  readonly createdAt: string;
  readonly lastSuccessAt: string | null;
  /** Failed deliveries in a row; the device is dropped at 5. */
  readonly failures: number;
}

export interface PushDevicesDto {
  readonly devices: readonly PushDeviceDto[];
}

/** `POST /api/v1/push/test`: how the fan-out went. */
export interface PushSendResultDto {
  /** Accepted by the push service. */
  readonly sent: number;
  /** Removed: gone (404/410) or failed 5 times in a row. */
  readonly pruned: number;
  /** Failed this time and kept. */
  readonly failed: number;
}

export type PushProblemType =
  /** 422: not an allowed push endpoint, or malformed keys. */
  | 'push-invalid-subscription'
  /** 503: the VAPID key pair or subject is not configured on this environment. */
  | 'push-misconfigured'
  /** 429 with `Retry-After`: a test push was sent less than 30 s ago. */
  | 'push-test-too-soon';
