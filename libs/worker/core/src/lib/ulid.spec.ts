import { newUlid } from './ulid';

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe('newUlid', () => {
  it('is 26 Crockford base32 characters', () => {
    expect(newUlid()).toMatch(ULID);
  });

  it('encodes the time in its first ten characters, sortable by text', () => {
    const earlier = newUlid(1_700_000_000_000);
    const later = newUlid(1_700_000_000_001);
    expect(earlier.slice(0, 10)).toBe('01HF7YAT00');
    expect(earlier.slice(0, 10) < later.slice(0, 10)).toBe(true);
  });

  it('never repeats its random tail', () => {
    const tails = new Set(Array.from({ length: 200 }, () => newUlid(0).slice(10)));
    expect(tails.size).toBe(200);
  });
});
