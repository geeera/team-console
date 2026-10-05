import { encodeBase64Url } from './base64url';
import { checkPushSubscription, isAllowedPushEndpoint, MAX_ENDPOINT_LENGTH } from './subscription';

const point = new Uint8Array(65).fill(7);
point[0] = 0x04;
const P256DH = encodeBase64Url(point);
const AUTH = encodeBase64Url(new Uint8Array(16).fill(9));

function body(endpoint: string, keys: Record<string, unknown> = { p256dh: P256DH, auth: AUTH }): unknown {
  return { endpoint, expirationTime: null, keys };
}

describe('isAllowedPushEndpoint (threat model on #11, row 1)', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc:APA91bH',
    'https://web.push.apple.com/QGq7Lw',
    'https://api.push.apple.com/3/device/x',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAAAA',
    'https://autopush.push.services.mozilla.com/wpush/v1/x',
    'https://wns2-par02p.notify.windows.com/w/?token=BQYAAAD',
  ])('accepts %s', (endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(true);
  });

  it.each([
    ['plain http', 'http://fcm.googleapis.com/fcm/send/x'],
    ['an IP literal', 'https://127.0.0.1/x'],
    ['an IPv6 literal', 'https://[::1]/x'],
    ['an unknown host', 'https://evil.example/x'],
    ['a lookalike suffix', 'https://fcm.googleapis.com.evil.example/x'],
    ['a lookalike prefix', 'https://evilpush.apple.com/x'],
    ['the bare suffix', 'https://push.apple.com/x'],
    ['a port', 'https://fcm.googleapis.com:8443/x'],
    ['the default port spelled out', 'https://fcm.googleapis.com:443/x'],
    ['credentials', 'https://user:pass@fcm.googleapis.com/x'],
    ['a trailing dot', 'https://fcm.googleapis.com./x'],
    ['upper case (not canonical)', 'https://FCM.googleapis.com/x'],
    ['another scheme', 'javascript:alert(1)'],
    ['a relative URL', '/fcm/send/x'],
    ['not a URL', 'not a url'],
    ['an over-long URL', `https://fcm.googleapis.com/${'a'.repeat(MAX_ENDPOINT_LENGTH)}`],
  ])('refuses %s', (_, endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(false);
  });
});

describe('checkPushSubscription (row 2)', () => {
  it('accepts a browser subscription and keeps exactly endpoint and keys', () => {
    expect(checkPushSubscription(body('https://web.push.apple.com/abc'))).toEqual({
      ok: true,
      subscription: { endpoint: 'https://web.push.apple.com/abc', p256dh: P256DH, auth: AUTH },
    });
  });

  it('accepts padded base64url keys', () => {
    expect(checkPushSubscription(body('https://web.push.apple.com/abc', { p256dh: P256DH, auth: `${AUTH}==` })).ok).toBe(
      true,
    );
  });

  const compressed = new Uint8Array(65).fill(7);
  compressed[0] = 0x02;

  it.each([
    ['a non-object', 'x'],
    ['an array', []],
    ['no keys', { endpoint: 'https://web.push.apple.com/abc' }],
    ['a bad endpoint', body('https://evil.example/x')],
    ['p256dh of 64 bytes', body('https://web.push.apple.com/a', { p256dh: encodeBase64Url(point.slice(1)), auth: AUTH })],
    ['p256dh not starting 0x04', body('https://web.push.apple.com/a', { p256dh: encodeBase64Url(compressed), auth: AUTH })],
    ['p256dh in standard base64', body('https://web.push.apple.com/a', { p256dh: `${P256DH.slice(0, -1)}+`, auth: AUTH })],
    ['auth of 15 bytes', body('https://web.push.apple.com/a', { p256dh: P256DH, auth: encodeBase64Url(new Uint8Array(15)) })],
    ['auth of 17 bytes', body('https://web.push.apple.com/a', { p256dh: P256DH, auth: encodeBase64Url(new Uint8Array(17)) })],
    ['a numeric key', body('https://web.push.apple.com/a', { p256dh: 1, auth: AUTH })],
    ['a string expirationTime', { ...(body('https://web.push.apple.com/a') as object), expirationTime: 'soon' }],
  ])('refuses %s with a reason that does not echo the input', (_, input) => {
    const result = checkPushSubscription(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).not.toContain('evil');
      expect(result.reason).not.toContain(P256DH);
    }
  });
});
