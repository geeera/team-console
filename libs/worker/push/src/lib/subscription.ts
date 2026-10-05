import { decodeBase64Url } from './base64url';

/** A subscription that passed every check below, ready to store. */
export interface ValidPushSubscription {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

export type SubscriptionCheck =
  | { readonly ok: true; readonly subscription: ValidPushSubscription }
  | { readonly ok: false; readonly reason: string };

/** Longer than any real push endpoint (Apple's and FCM's are under 300 characters). */
export const MAX_ENDPOINT_LENGTH = 1024;

/** Exact hosts of the push services the console sends to (threat model on #11, row 1). */
const EXACT_HOSTS: ReadonlySet<string> = new Set(['fcm.googleapis.com', 'updates.push.services.mozilla.com']);
/** Host suffixes; a label must precede them (`web.push.apple.com`, `wns2-…notify.windows.com`). */
const HOST_SUFFIXES: readonly string[] = ['.push.apple.com', '.push.services.mozilla.com', '.notify.windows.com'];

/**
 * Whether the Worker may POST to this URL: `https:` on the default port, no credentials, and a host on the push
 * services' allow-list. The endpoint is client-supplied and the Worker fetches it later with a signed VAPID JWT, so
 * anything else (an IP literal, a port, a lookalike host) is refused before it is stored.
 */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  if (endpoint.length > MAX_ENDPOINT_LENGTH) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') {
    return false;
  }
  // `new URL` keeps the input's spelling only when it is already canonical; anything it rewrote is suspect.
  if (url.href !== endpoint) {
    return false;
  }
  const host = url.hostname;
  return (
    EXACT_HOSTS.has(host) ||
    HOST_SUFFIXES.some((suffix) => host.endsWith(suffix) && /^[a-z0-9-]+$/.test(host.slice(0, -suffix.length)))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An uncompressed P-256 point: 65 bytes, `0x04` first (threat model on #11, row 2). */
export function isP256dhKey(value: string): boolean {
  const bytes = decodeBase64Url(value);
  return bytes !== null && bytes.length === 65 && bytes[0] === 0x04;
}

/** The 16-byte authentication secret of RFC 8291 §3.2. */
export function isAuthSecret(value: string): boolean {
  const bytes = decodeBase64Url(value);
  return bytes !== null && bytes.length === 16;
}

/**
 * Checks `PushSubscription.toJSON()` from the client. The reason names the failed rule only; it never echoes the
 * input back.
 */
export function checkPushSubscription(body: unknown): SubscriptionCheck {
  if (!isRecord(body)) {
    return { ok: false, reason: 'The body must be a push subscription object' };
  }
  const { endpoint, keys, expirationTime } = body;
  if (typeof endpoint !== 'string' || !isAllowedPushEndpoint(endpoint)) {
    return { ok: false, reason: 'The endpoint is not an https URL of a known push service' };
  }
  if (expirationTime !== undefined && expirationTime !== null && typeof expirationTime !== 'number') {
    return { ok: false, reason: 'expirationTime must be a number or null' };
  }
  if (!isRecord(keys)) {
    return { ok: false, reason: 'keys must hold p256dh and auth' };
  }
  const { p256dh, auth } = keys;
  if (typeof p256dh !== 'string' || !isP256dhKey(p256dh)) {
    return { ok: false, reason: 'keys.p256dh must be a base64url uncompressed P-256 point (65 bytes)' };
  }
  if (typeof auth !== 'string' || !isAuthSecret(auth)) {
    return { ok: false, reason: 'keys.auth must be 16 bytes of base64url' };
  }
  return { ok: true, subscription: { endpoint, p256dh, auth } };
}
