import { looksBlank, withoutInvisibles } from './invisibles';

const point = (code: number): string => String.fromCodePoint(code);

describe('withoutInvisibles', () => {
  it('removes bidi overrides, isolates and marks, so a title reads in its written order', () => {
    const [rlo, pdf, lri, pdi, lrm, rlm, alm] = [0x202e, 0x202c, 0x2066, 0x2069, 0x200e, 0x200f, 0x61c].map(point);
    expect(withoutInvisibles(`Pay${rlo}gro.live${pdf} ${lri}now${pdi}${lrm}${rlm}${alm}`)).toBe('Paygro.live now');
  });

  it('removes zero-width characters, the word joiner, the soft hyphen and the BOM', () => {
    const [zwsp, zwnj, wj, shy, bom] = [0x200b, 0x200c, 0x2060, 0xad, 0xfeff].map(point);
    expect(withoutInvisibles(`${bom}Ap${zwsp}prove${zwnj} the${wj} ${shy}plan`)).toBe('Approve the plan');
  });

  it('removes the Hangul fillers and the tag characters', () => {
    const fillers = [0x115f, 0x1160, 0x3164].map(point).join('');
    const tags = [0xe0001, 0xe0020, 0xe007f].map(point).join('');
    expect(withoutInvisibles(`a${fillers}b${tags}c`)).toBe('abc');
  });

  it('removes C0 and C1 controls but keeps tab and newline', () => {
    expect(withoutInvisibles(`a${point(0x07)}b\tc\n${point(0x9f)}d${point(0x7f)}`)).toBe('ab\tc\nd');
  });

  it('keeps the zero-width joiner, so emoji sequences stay whole', () => {
    expect(withoutInvisibles('👩‍💻 and 🏳️‍🌈')).toBe('👩‍💻 and 🏳️‍🌈');
  });

  it('keeps variation selectors: a presentation hint on real content is not invisible (#470 review)', () => {
    expect(withoutInvisibles('Favorites ❤️')).toBe('Favorites ❤️');
    expect(withoutInvisibles('🏳️‍🌈')).toBe('🏳️‍🌈');
  });

  it('leaves ordinary text, Cyrillic, Arabic and Hebrew letters as they are', () => {
    const text = 'Экран дизайна — مرحبا — שלום — café, 日本語';
    expect(withoutInvisibles(text)).toBe(text);
  });

  it('is linear on long runs of the characters it removes', () => {
    const started = performance.now();
    withoutInvisibles(`${point(0x202e).repeat(60_000)}x${point(0xe0001).repeat(60_000)}`);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

// #470 item 5, round 2: a title made only of characters that carry meaning only attached to a base character (a
// variation selector, a Mongolian selector, a lone ZWJ) or that render as blank without being invisible (Braille
// blank, the halfwidth Hangul filler) still reads blank. `withoutInvisibles` keeps these (stripping them would
// corrupt real content, found in review on 37271fd); `title()`/`sprintTitle()` instead reject such a value the way
// they reject an empty one.
describe('looksBlank', () => {
  it('is blank: empty, whitespace only, or a lone variation selector', () => {
    expect(looksBlank('')).toBe(true);
    expect(looksBlank('   \t\n')).toBe(true);
    expect(looksBlank(point(0xfe0f))).toBe(true);
    expect(looksBlank([0xfe00, 0xfe0d, 0xfe0f].map(point).join(''))).toBe(true);
  });

  it('is blank: the variation selector supplement, VS17-VS256 (U+E0100-E01EF)', () => {
    expect(looksBlank(point(0xe0100))).toBe(true);
    expect(looksBlank(point(0xe01ef))).toBe(true);
  });

  it('is blank: the Mongolian selectors, including U+180E between the two ranges', () => {
    expect(looksBlank([0x180b, 0x180c, 0x180d, 0x180e, 0x180f].map(point).join(''))).toBe(true);
  });

  it('is blank: the Braille blank pattern and the halfwidth Hangul filler', () => {
    expect(looksBlank(point(0x2800).repeat(3))).toBe(true);
    expect(looksBlank(point(0xffa0))).toBe(true);
  });

  it('is blank: the combining grapheme joiner, the Khmer inherence marks and the musical combining marks', () => {
    expect(looksBlank(point(0x34f))).toBe(true);
    expect(looksBlank(point(0x17b4))).toBe(true);
    expect(looksBlank(point(0x17b5))).toBe(true);
    expect(looksBlank(point(0x1d173))).toBe(true);
    expect(looksBlank(point(0x1d17a))).toBe(true);
  });

  it('is blank: a lone zero-width joiner, with nothing to join', () => {
    expect(looksBlank(point(0x200d))).toBe(true);
  });

  it('is not blank: real content with a variation selector or a ZWJ sequence attached to it', () => {
    expect(looksBlank('Favorites ❤️')).toBe(false);
    expect(looksBlank('🏳️‍🌈')).toBe(false);
    expect(looksBlank('👩‍💻')).toBe(false);
  });

  it('is not blank: ordinary text', () => {
    expect(looksBlank('Hello')).toBe(false);
    expect(looksBlank('Экран дизайна')).toBe(false);
  });
});
