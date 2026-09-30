import {
  MasterKeyError,
  UnsealError,
  importMasterKey,
  openText,
  randomHex,
  sealText,
  timingSafeEqualText,
} from './sealed';

function keyOfBytes(length: number, fill = 7): string {
  return btoa(String.fromCharCode(...new Uint8Array(length).fill(fill)));
}

const MASTER = keyOfBytes(32);

describe('importMasterKey', () => {
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['31 bytes', keyOfBytes(31)],
    ['33 bytes', keyOfBytes(33)],
    ['not base64', '!!not base64!!'],
  ])('refuses a %s key', async (_label, value) => {
    await expect(importMasterKey(value)).rejects.toBeInstanceOf(MasterKeyError);
  });

  it('derives key_id as the first 8 hex digits of SHA-256 of the key bytes', async () => {
    const bytes = new Uint8Array(32).fill(7);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const expected = Array.from(digest.slice(0, 4), (b) => b.toString(16).padStart(2, '0')).join('');

    const master = await importMasterKey(MASTER);

    expect(master.keyId).toBe(expected);
    expect((await importMasterKey(keyOfBytes(32, 8))).keyId).not.toBe(master.keyId);
  });
});

describe('sealText / openText', () => {
  it('round-trips, and two seals of the same value differ (fresh IV)', async () => {
    const key = await (await importMasterKey(MASTER)).deriveKey('dev', 'owner-token-v1');

    const first = await sealText(key, 'value', 'dev:access_token_enc');
    const second = await sealText(key, 'value', 'dev:access_token_enc');

    expect(first).not.toBe(second);
    expect(first).toMatch(/^[0-9a-f]+$/);
    expect(await openText(key, first, 'dev:access_token_enc')).toBe('value');
  });

  it('does not open under another AAD (a value moved to another column)', async () => {
    const key = await (await importMasterKey(MASTER)).deriveKey('dev', 'owner-token-v1');
    const sealed = await sealText(key, 'value', 'dev:access_token_enc');

    await expect(openText(key, sealed, 'dev:refresh_token_enc')).rejects.toBeInstanceOf(UnsealError);
  });

  it('does not open under another salt (another environment) or another info (another purpose)', async () => {
    const master = await importMasterKey(MASTER);
    const sealed = await sealText(await master.deriveKey('dev', 'owner-token-v1'), 'value', 'aad');

    await expect(
      openText(await master.deriveKey('stage', 'owner-token-v1'), sealed, 'aad'),
    ).rejects.toBeInstanceOf(UnsealError);
    await expect(
      openText(await master.deriveKey('dev', 'oauth-state-v1'), sealed, 'aad'),
    ).rejects.toBeInstanceOf(UnsealError);
  });

  it('does not open a flipped bit, a truncated value or garbage', async () => {
    const key = await (await importMasterKey(MASTER)).deriveKey('dev', 'owner-token-v1');
    const sealed = await sealText(key, 'value', 'aad');
    const last = sealed.at(-1) === '0' ? '1' : '0';

    for (const bad of [`${sealed.slice(0, -1)}${last}`, sealed.slice(0, 40), 'zz', '', `${sealed}0`]) {
      await expect(openText(key, bad, 'aad')).rejects.toBeInstanceOf(UnsealError);
    }
  });
});

describe('timingSafeEqualText', () => {
  it('is true only for equal strings', () => {
    expect(timingSafeEqualText('abc', 'abc')).toBe(true);
    expect(timingSafeEqualText('abc', 'abd')).toBe(false);
    expect(timingSafeEqualText('abc', 'abcd')).toBe(false);
    expect(timingSafeEqualText('', 'a')).toBe(false);
  });
});

describe('randomHex', () => {
  it('returns 2 hex digits per byte, different every time', () => {
    const value = randomHex(32);
    expect(value).toMatch(/^[0-9a-f]{64}$/);
    expect(randomHex(32)).not.toBe(value);
  });
});
