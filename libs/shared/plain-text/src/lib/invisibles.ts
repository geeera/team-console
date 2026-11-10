/**
 * Characters that show nothing yet change how text reads (#287, #288, #470 item 5): C0/C1 controls except tab and
 * newline, the soft hyphen, the zero-width space and non-joiner, the bidi marks, embeddings, overrides and isolates
 * (U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069), the word joiner and invisible operators, the Hangul
 * fillers, the BOM, the tag characters, the variation selectors (U+FE00–FE0F) and the Mongolian ones (U+180B–U+180D,
 * U+180F), and the Braille blank pattern (U+2800, a glyph of zero dots — visually indistinguishable from a space).
 * ZWJ (U+200D) stays: emoji sequences need it. Built from code points, so the source shows exactly which characters
 * are meant.
 */
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x08],
  [0x0b, 0x1f],
  [0x7f, 0x9f],
  [0xad, 0xad],
  [0x180b, 0x180d],
  [0x180f, 0x180f],
  [0x61c, 0x61c],
  [0x115f, 0x1160],
  [0x200b, 0x200c],
  [0x200e, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0x2800, 0x2800],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xe0000, 0xe007f],
];

const INVISIBLE = new RegExp(
  `[${INVISIBLE_RANGES.map(([from, to]) => `\\u{${from.toString(16)}}-\\u{${to.toString(16)}}`).join('')}]`,
  'gu',
);

/**
 * `text` without the invisible characters above, for untrusted titles and other one-line text shown as is: a bidi
 * override or a zero-width run can make one item read as another (#287). The result is still plain text for
 * interpolation only, never markup.
 */
export function withoutInvisibles(text: string): string {
  return text.replace(INVISIBLE, '');
}
