import { describe, expect, it } from 'vitest';
import { highlightSegments } from './highlight-segments';

describe('highlightSegments', () => {
  it('returns the whole title as one plain run without terms', () => {
    expect(highlightSegments('Release notes', [])).toEqual([{ text: 'Release notes', isMatch: false }]);
  });

  it('marks every hit case-insensitively and keeps the original casing', () => {
    expect(highlightSegments('Release notes for RELEASE', ['release'])).toEqual([
      { text: 'Release', isMatch: true },
      { text: ' notes for ', isMatch: false },
      { text: 'RELEASE', isMatch: true },
    ]);
  });

  it('marks each word of a multi-word query, in any order', () => {
    expect(highlightSegments('Demo of the board', ['board', 'demo'])).toEqual([
      { text: 'Demo', isMatch: true },
      { text: ' of the ', isMatch: false },
      { text: 'board', isMatch: true },
    ]);
  });

  it('merges touching hits into one run', () => {
    expect(highlightSegments('abcd', ['ab', 'cd'])).toEqual([{ text: 'abcd', isMatch: true }]);
  });

  it('treats regex characters as plain text', () => {
    expect(highlightSegments('a (b) [c] a.b', ['(b)', '.b'])).toEqual([
      { text: 'a ', isMatch: false },
      { text: '(b)', isMatch: true },
      { text: ' [c] a', isMatch: false },
      { text: '.b', isMatch: true },
    ]);
  });

  it('returns the title plain when nothing matches, and handles an empty title', () => {
    expect(highlightSegments('Decision', ['zzz'])).toEqual([{ text: 'Decision', isMatch: false }]);
    expect(highlightSegments('', ['a'])).toEqual([{ text: '', isMatch: false }]);
  });

  it('keeps markup in a title as text', () => {
    expect(highlightSegments('<b>x</b>', ['x'])).toEqual([
      { text: '<b>', isMatch: false },
      { text: 'x', isMatch: true },
      { text: '</b>', isMatch: false },
    ]);
  });

  it('marks an ASCII title as before (no fold involved)', () => {
    expect(highlightSegments('Board phone lanes', ['board', 'lanes'])).toEqual([
      { text: 'Board', isMatch: true },
      { text: ' phone ', isMatch: false },
      { text: 'lanes', isMatch: true },
    ]);
  });

  it('marks a title with the Turkish dotless ı for a plain ASCII "i" query, keeping the title\'s own letters (#945)', () => {
    expect(highlightSegments('Kızılay meydanı', ['kizilay'])).toEqual([
      { text: 'Kızılay', isMatch: true },
      { text: ' meydanı', isMatch: false },
    ]);
  });

  it('marks a title with the Turkish dotted İ for a plain ASCII "i" query (#945)', () => {
    expect(highlightSegments('İstanbul köprüsü', ['istanbul'])).toEqual([
      { text: 'İstanbul', isMatch: true },
      { text: ' köprüsü', isMatch: false },
    ]);
  });

  it('marks an all-caps Greek title ending in Σ for a lowercase query, final sigma included (#950)', () => {
    // "ΣΑΣ".toLowerCase() picks the word-final "ς" for the last letter, but folding the title one character at
    // a time (as the title is folded here) gives the medial "σ" instead; both sides must agree.
    expect(highlightSegments('ΣΑΣ είναι εδώ', ['σας'])).toEqual([
      { text: 'ΣΑΣ', isMatch: true },
      { text: ' είναι εδώ', isMatch: false },
    ]);
  });

  it('marks a title with an astral (surrogate-pair) character before the match at the right offsets', () => {
    // "🎉" and "𝐀" are each one surrogate pair (2 UTF-16 code units, 1 code point): the match on "Board" must
    // land after them, not one unit short or long.
    expect(highlightSegments('🎉 Board phone lanes', ['board'])).toEqual([
      { text: '🎉 ', isMatch: false },
      { text: 'Board', isMatch: true },
      { text: ' phone lanes', isMatch: false },
    ]);
    expect(highlightSegments('𝐀 board game', ['board'])).toEqual([
      { text: '𝐀 ', isMatch: false },
      { text: 'board', isMatch: true },
      { text: ' game', isMatch: false },
    ]);
  });
});
