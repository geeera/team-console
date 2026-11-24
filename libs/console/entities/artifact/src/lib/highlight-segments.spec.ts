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
});
