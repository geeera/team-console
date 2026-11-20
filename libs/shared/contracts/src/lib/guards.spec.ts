import { describe, expect, it } from 'vitest';
import { DISPLAY_NAME_MAX, isDisplayName } from './guards';

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
