import { withoutInvisibles } from './invisibles';

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
