import type { Artifact } from '@console/entities/artifact';
import { ARTIFACT_TYPES, type ArtifactType } from '@shared/contracts';

export interface ArtifactFilterValue {
  /** `null` = every type. */
  readonly type: ArtifactType | null;
  readonly query: string;
}

/** The longest query kept (URL and local state); longer input is cut, never refused. */
export const ARTIFACT_QUERY_MAX_LENGTH = 200;

function termsOf(query: string): string[] {
  return query
    .slice(0, ARTIFACT_QUERY_MAX_LENGTH)
    .toLocaleLowerCase()
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
  const terms = termsOf(filter.query);
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
    const title = item.title.toLocaleLowerCase();
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
