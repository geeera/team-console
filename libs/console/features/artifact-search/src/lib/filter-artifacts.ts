import type { Artifact } from '@console/entities/artifact';
import { ARTIFACT_TYPES, type ArtifactType } from '@shared/contracts';

export interface ArtifactFilterValue {
  /** `null` = every type. */
  readonly type: ArtifactType | null;
  readonly query: string;
}

/** The longest query kept (URL and local state); longer input is cut, never refused. */
export const ARTIFACT_QUERY_MAX_LENGTH = 200;

/** Every Latin "i" the Turkish case pair splits in two: dotted capital and dotless lowercase. */
const TURKISH_I_VARIANTS = /[İIıi]/g;

/**
 * A case fold that does not depend on the host's locale (#945). `toLocaleLowerCase()` alone mishandles the Turkish
 * dotted İ: under the non-Turkish default it lowers to "i" plus a combining dot above (2 code points), which never
 * `includes()`-matches a plain "i" — a real bug for anyone typing a Turkish word, not only on a `tr` device. Folding
 * all four of İ/I/ı/i to the same "i" first keeps the match independent of both the input's and the host's locale.
 */
function foldCase(text: string): string {
  return text.replace(TURKISH_I_VARIANTS, 'i').toLocaleLowerCase();
}

/** The folded words of a query: what `filterArtifacts` requires and the list underlines. */
export function artifactQueryTerms(query: string): string[] {
  return foldCase(query.slice(0, ARTIFACT_QUERY_MAX_LENGTH))
    .split(/\s+/)
    .filter((term) => term !== '');
}

/**
 * The artifacts of the chosen type whose title holds every word of the query (case-insensitive, any order). Pure and
 * linear in the list, so it runs on every keystroke: 250 items stay far under one frame (see the spec).
 */
export function filterArtifacts(
  items: readonly Artifact[],
  filter: ArtifactFilterValue,
): readonly Artifact[] {
  const terms = artifactQueryTerms(filter.query);
  if (filter.type === null && terms.length === 0) {
    return items;
  }
  return items.filter((item) => {
    if (filter.type !== null && item.type !== filter.type) {
      return false;
    }
    if (terms.length === 0) {
      return true;
    }
    const title = foldCase(item.title);
    return terms.every((term) => title.includes(term));
  });
}

/** How many artifacts each type tab holds. */
export function artifactTypeCounts(items: readonly Artifact[]): Readonly<Record<ArtifactType, number>> {
  const counts = Object.fromEntries(ARTIFACT_TYPES.map((type) => [type, 0])) as Record<ArtifactType, number>;
  for (const item of items) {
    counts[item.type] += 1;
  }
  return counts;
}
