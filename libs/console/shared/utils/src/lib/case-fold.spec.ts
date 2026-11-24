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

  it('folds the Greek final sigma (Σ at the end of a word) to the medial σ, same as a non-final one (#950)', () => {
    // Plain .toLowerCase() picks the final sigma "ς" only when the capital Σ ends the string ("ΣΑΣ" → "σας"),
    // which disagrees with folding the same letter alone ("Σ" → "σ") — this is what a per-character fold hits.
    expect(caseFold('ΣΑΣ')).toBe('σασ');
    expect(caseFold('Σ')).toBe('σ');
    expect(caseFold('ς')).toBe('σ');
  });
});
