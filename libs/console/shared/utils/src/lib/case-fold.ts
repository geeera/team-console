/** Every Latin "i" the Turkish case pair splits in two: dotted capital and dotless lowercase. */
const TURKISH_I_VARIANTS = /[İIıi]/g;

/** The Greek final sigma (word-ending position) folds to a different code point than the medial one. Matching
 * must not depend on position, so both fold to the medial σ (#950): without this, lowercasing a whole term
 * ("ΣΑΣ" → "σας") disagrees with lowercasing `highlightSegments`' title one character at a time ("Σ" → "σ"). */
const GREEK_FINAL_SIGMA = /ς/g;

/** A case fold that treats İ/I/ı/i as the same letter, independent of the host's locale, and folds the Greek
 * final sigma to its medial form so folding stays the same whether done on a whole string or character by
 * character (#945, #950). */
export function caseFold(text: string): string {
  return text.replace(TURKISH_I_VARIANTS, 'i').toLocaleLowerCase().replace(GREEK_FINAL_SIGMA, 'σ');
}
