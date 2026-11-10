/**
 * Characters that show nothing yet change how text reads (#287, #288): C0/C1 controls except tab and newline, the
 * soft hyphen, the zero-width space and non-joiner, the bidi marks, embeddings, overrides and isolates (U+061C, U+200E,
 * U+200F, U+202A–U+202E, U+2066–U+2069), the word joiner and invisible operators, the Hangul fillers, the BOM and the
 * tag characters. ZWJ (U+200D) stays: emoji sequences need it. Built from code points, so the source shows exactly
 * which characters are meant.
 */
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x08],
  [0x0b, 0x1f],
  [0x7f, 0x9f],
  [0xad, 0xad],
  [0x61c, 0x61c],
  [0x115f, 0x1160],
  [0x200b, 0x200c],
  [0x200e, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0x3164, 0x3164],
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
 * interpolation only, never markup. These characters are never kept, so a title that is only them is caught by
 * `looksBlank`, never stored looking like content.
 */
export function withoutInvisibles(text: string): string {
  return text.replace(INVISIBLE, '');
}

/**
 * Whether `text` has nothing a reader would see: empty or whitespace only, or made only of characters Unicode marks
 * `Default_Ignorable_Code_Point` — variation selectors (including the VS17–256 supplement, U+E0100–E01EF), the
 * Mongolian selectors, U+180E, the combining grapheme joiner (U+034F), the Khmer vowel inherence marks (U+17B4/5), the
 * musical symbol combining marks (U+1D173–1D17A) and a lone ZWJ among them — plus the Braille blank pattern (U+2800)
 * and the halfwidth Hangul filler (U+FFA0), which are not in that Unicode property but render just as blank (#470
 * item 5). These characters carry real meaning attached to a base character — a variation selector picks an emoji's
 * presentation ("Favorites ❤️", 🏳️‍🌈's VS16) or a letterform, a ZWJ joins an emoji sequence — so `withoutInvisibles`
 * never strips them from real content; `looksBlank` instead catches a title or sprint name made of *only* these.
 */
const BLANK_LOOKING = /^[\s\p{Default_Ignorable_Code_Point}⠀ﾠ]*$/u;

export function looksBlank(text: string): boolean {
  return BLANK_LOOKING.test(text);
}
