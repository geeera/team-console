import { signatureOf } from '../testing/webhook-kit';
import { sha256Hex, verifySignature, webhookSecretsOf } from './signature';

const encoder = new TextEncoder();
const body = '{"action":"opened","number":1}';
const bytes = (text: string): ArrayBuffer => encoder.encode(text).buffer as ArrayBuffer;

describe('webhookSecretsOf', () => {
  it('fails closed on a missing or empty current secret', () => {
    expect(webhookSecretsOf(undefined, undefined)).toBeNull();
    expect(webhookSecretsOf('', 'old')).toBeNull();
  });

  it('adds the previous secret only when it is set and not empty', () => {
    expect(webhookSecretsOf('new', undefined)).toEqual(['new']);
    expect(webhookSecretsOf('new', '')).toEqual(['new']);
    expect(webhookSecretsOf('new', 'old')).toEqual(['new', 'old']);
  });
});

describe('verifySignature', () => {
  it('accepts the HMAC-SHA256 of the exact bytes', async () => {
    await expect(verifySignature(['k'], bytes(body), await signatureOf(body, 'k'))).resolves.toBe(true);
  });

  it('accepts either secret during a rotation, only the listed ones otherwise', async () => {
    const signedWithOld = await signatureOf(body, 'old');
    await expect(verifySignature(['new', 'old'], bytes(body), signedWithOld)).resolves.toBe(true);
    await expect(verifySignature(['new'], bytes(body), signedWithOld)).resolves.toBe(false);
  });

  it('refuses a valid signature over a re-serialised body', async () => {
    const reserialised = JSON.stringify(JSON.parse(body) as unknown, null, 2);
    await expect(verifySignature(['k'], bytes(reserialised), await signatureOf(body, 'k'))).resolves.toBe(
      false,
    );
  });

  it.each([
    ['missing', null],
    ['empty', ''],
    ['sha1', 'sha1=0123456789abcdef0123456789abcdef01234567'],
    ['short hex', 'sha256=abcdef'],
    ['no prefix', '0'.repeat(64)],
    ['trailing space', `sha256=${'0'.repeat(64)} `],
  ])('refuses a %s header without throwing', async (_name, header) => {
    await expect(verifySignature(['k'], bytes(body), header)).resolves.toBe(false);
  });

  it('refuses the right signature written in upper-case hex', async () => {
    const signature = await signatureOf(body, 'k');
    const upper = `sha256=${signature.slice('sha256='.length).toUpperCase()}`;
    await expect(verifySignature(['k'], bytes(body), upper)).resolves.toBe(false);
  });
});

describe('sha256Hex', () => {
  it('hashes the raw bytes to lower-case hex', async () => {
    await expect(sha256Hex(bytes('abc'))).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
