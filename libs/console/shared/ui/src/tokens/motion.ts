/**
 * The last place (0-based) of a staggered list: 8 rows get their own delay, the rest share the last one. Repeated
 * from `tokens.css` (`--stagger-max`), which `.m-stagger` reads; `motion.spec.ts` keeps them equal.
 */
export const STAGGER_MAX_INDEX = 7;

/** The place a row takes in a stagger: its index, held at the cap. */
export function staggerIndex(index: number): number {
  return Math.min(index, STAGGER_MAX_INDEX);
}
