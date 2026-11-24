/** Every Latin "i" the Turkish case pair splits in two: dotted capital and dotless lowercase. */
const TURKISH_I_VARIANTS = /[İIıi]/g;

/** A case fold that treats İ/I/ı/i as the same letter, independent of the host's locale (#945). */
export function caseFold(text: string): string {
  return text.replace(TURKISH_I_VARIANTS, 'i').toLocaleLowerCase();
}
