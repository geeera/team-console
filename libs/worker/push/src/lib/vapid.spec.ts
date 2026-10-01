import { encodeBase64Url } from './base64url';
import { checkVapidConfig } from './vapid';

const point = new Uint8Array(65).fill(3);
point[0] = 0x04;
const PUBLIC = encodeBase64Url(point);
const PRIVATE = encodeBase64Url(new Uint8Array(32).fill(5));
const SUBJECT = 'https://github.com/geeera/team-console';

describe('checkVapidConfig', () => {
  it('accepts a 65-byte public key, a 32-byte private key and an https subject', () => {
    expect(checkVapidConfig({ publicKey: PUBLIC, privateKey: PRIVATE, subject: SUBJECT })).toEqual({
      ok: true,
      config: { publicKey: PUBLIC, privateKey: PRIVATE, subject: SUBJECT },
    });
  });

  it('fails closed on missing settings, naming them without values', () => {
    expect(checkVapidConfig({})).toEqual({ ok: false, invalid: ['publicKey', 'privateKey', 'subject'] });
  });

  it.each([
    ['a mailto subject (the owner e-mail must not be published)', { subject: 'mailto:owner@example.com' }, 'subject'],
    ['an http subject', { subject: 'http://example.com' }, 'subject'],
    ['a 33-byte private key', { privateKey: encodeBase64Url(new Uint8Array(33)) }, 'privateKey'],
    ['a compressed public key', { publicKey: encodeBase64Url(point.slice(0, 33)) }, 'publicKey'],
  ])('refuses %s', (_, override, name) => {
    const result = checkVapidConfig({ publicKey: PUBLIC, privateKey: PRIVATE, subject: SUBJECT, ...override });
    expect(result).toEqual({ ok: false, invalid: [name] });
    expect(JSON.stringify(result)).not.toContain(PRIVATE);
  });
});
