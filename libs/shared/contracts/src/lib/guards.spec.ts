import { describe, expect, it } from 'vitest';
import { DISPLAY_NAME_MAX, isCount, isDisplayName } from './guards';

describe('isDisplayName', () => {
  it('accepts a name of exactly the maximum in code points, even when astral', () => {
    expect(isDisplayName('😀'.repeat(DISPLAY_NAME_MAX))).toBe(true);
  });

  it('rejects a name one code point over the maximum', () => {
    expect(isDisplayName('😀'.repeat(DISPLAY_NAME_MAX + 1))).toBe(false);
  });

  it('rejects the empty string and non-strings', () => {
    expect(isDisplayName('')).toBe(false);
    expect(isDisplayName(null)).toBe(false);
  });
});

describe('isCount', () => {
  it('accepts zero and positive safe integers', () => {
    expect(isCount(0)).toBe(true);
    expect(isCount(3)).toBe(true);
  });

  it('rejects negatives, fractions, unsafe integers and non-numbers', () => {
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, '2', null]) {
      expect(isCount(value)).toBe(false);
    }
  });
});
