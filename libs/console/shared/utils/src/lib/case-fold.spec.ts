import { describe, expect, it } from 'vitest';
import { caseFold } from './case-fold';

describe('caseFold', () => {
  it('folds the dotted capital İ to plain "i"', () => {
    // The bug this closes: under the default (non-`tr`) locale, "İ".toLowerCase() is "i" plus a combining dot
    // above (2 code points), which never matches a plain "i".
    expect(caseFold('İZMİR')).toBe('izmir');
  });

  it('folds the dotless lowercase ı to plain "i"', () => {
    expect(caseFold('KIZILAY')).toBe('kizilay');
    expect(caseFold('Kızılay')).toBe('kizilay');
  });

  it('folds ordinary ASCII I/i the same way', () => {
    expect(caseFold('Istanbul')).toBe('istanbul');
    expect(caseFold('istanbul')).toBe('istanbul');
  });

  it('leaves other scripts to the ordinary locale fold (Cyrillic)', () => {
    expect(caseFold('СТЕКЕ')).toBe('стеке');
  });
});
