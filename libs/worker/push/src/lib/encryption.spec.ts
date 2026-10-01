import { encryptNotification } from '@block65/webcrypto-web-push';
import { bytesOf, decryptPushPayload, generateReceiverKeys, importReceiverKeys } from '../testing';
import { encodeBase64Url } from './base64url';

// RFC 8291 Appendix A (whitespace removed). The sender side is the library the Worker uses; the receiver side is
// `@worker/push/testing`, written from the RFC on its own.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  message:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

const subscription = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/rfc8291',
  expirationTime: null,
  keys: { p256dh: RFC.uaPublic, auth: RFC.authSecret },
};

async function rfcSenderKeyPair(): Promise<CryptoKeyPair> {
  const point = bytesOf(RFC.asPublic);
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: encodeBase64Url(point.slice(1, 33)),
    y: encodeBase64Url(point.slice(33, 65)),
  };
  return {
    privateKey: await crypto.subtle.importKey('jwk', { ...jwk, d: RFC.asPrivate }, { name: 'ECDH', namedCurve: 'P-256' }, false, [
      'deriveBits',
    ]),
    publicKey: await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []),
  };
}

describe('aes128gcm payload encryption (RFC 8291)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reproduces the Appendix A message from its salt and sender key', async () => {
    const pair = await rfcSenderKeyPair();
    vi.spyOn(crypto.subtle, 'generateKey').mockResolvedValueOnce(pair);
    vi.spyOn(crypto, 'getRandomValues').mockImplementationOnce(<T extends ArrayBufferView | null>(array: T): T => {
      (array as unknown as Uint8Array).set(bytesOf(RFC.salt));
      return array;
    });

    const message = await encryptNotification(subscription, new TextEncoder().encode(RFC.plaintext), { pad: false });

    expect(encodeBase64Url(message)).toBe(RFC.message);
  });

  it('decrypts the Appendix A message with the user agent key (the test receiver is right too)', async () => {
    const receiver = await importReceiverKeys(RFC.uaPublic, RFC.uaPrivate, RFC.authSecret);
    const plaintext = await decryptPushPayload(bytesOf(RFC.message), receiver);
    expect(new TextDecoder().decode(plaintext)).toBe(RFC.plaintext);
  });

  it('uses a fresh salt and sender key per message: two encryptions of one message differ', async () => {
    const plaintext = new TextEncoder().encode('same message');
    const first = await encryptNotification(subscription, plaintext);
    const second = await encryptNotification(subscription, plaintext);

    expect(encodeBase64Url(first.slice(0, 16))).not.toBe(encodeBase64Url(second.slice(0, 16)));
    expect(encodeBase64Url(first.slice(21, 86))).not.toBe(encodeBase64Url(second.slice(21, 86)));
    expect(encodeBase64Url(first)).not.toBe(encodeBase64Url(second));
  });

  it('round-trips a padded message to a fresh browser key', async () => {
    const receiver = await generateReceiverKeys();
    const target = {
      endpoint: 'https://web.push.apple.com/round-trip',
      expirationTime: null,
      keys: { p256dh: encodeBase64Url(receiver.publicKey), auth: encodeBase64Url(receiver.authSecret) },
    };
    const message = await encryptNotification(target, new TextEncoder().encode('{"notification":{}}'));

    // Padded to the push services' 4096-byte limit, so the length tells an observer nothing.
    expect(message.length).toBe(4096);
    const plaintext = await decryptPushPayload(message, receiver);
    expect(new TextDecoder().decode(plaintext)).toBe('{"notification":{}}');
  });
});
