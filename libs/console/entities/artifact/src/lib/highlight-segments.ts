/** A run of a title: `isMatch` runs are what a search found (#362). */
export interface TitleSegment {
  readonly text: string;
  readonly isMatch: boolean;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Cuts `title` into plain and matched runs for the terms of a search (case-insensitive, as the filter matches).
 * Pure and markup-free: the caller renders each run as text, so GitHub's title never becomes HTML. Overlapping or
 * touching hits merge into one run; no terms give the whole title as one plain run.
 */
export function highlightSegments(title: string, terms: readonly string[]): readonly TitleSegment[] {
  const needles = terms.filter((term) => term !== '').sort((a, b) => b.length - a.length);
  if (needles.length === 0 || title === '') {
    return [{ text: title, isMatch: false }];
  }
  const pattern = new RegExp(needles.map(escapeRegExp).join('|'), 'giu');
  const segments: TitleSegment[] = [];
  let cursor = 0;
  for (const hit of title.matchAll(pattern)) {
    const start = hit.index;
    const previous = segments[segments.length - 1];
    if (start > cursor) {
      segments.push({ text: title.slice(cursor, start), isMatch: false });
    }
    if (start === cursor && previous?.isMatch === true) {
      segments[segments.length - 1] = { text: previous.text + hit[0], isMatch: true };
    } else {
      segments.push({ text: hit[0], isMatch: true });
    }
    cursor = start + hit[0].length;
  }
  if (cursor < title.length) {
    segments.push({ text: title.slice(cursor), isMatch: false });
  }
  return segments.length === 0 ? [{ text: title, isMatch: false }] : segments;
}
