import { caseFold } from '@console/shared/utils';

/** A run of a title: `isMatch` runs are what a search found (#362). */
export interface TitleSegment {
  readonly text: string;
  readonly isMatch: boolean;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `title`, folded character by character, with the folded-text offset each character starts at — folding can
 * change a character's length (the Turkish İ used to, under the default locale), so a match in the folded text
 * does not always line up with the same offsets in `title`. */
interface FoldedTitle {
  readonly text: string;
  /** `originalStarts[i]` / `foldedStarts[i]`: where character `i` of `title` begins in `title` / in `text`. One
   * extra trailing entry in each holds the respective total length. */
  readonly originalStarts: readonly number[];
  readonly foldedStarts: readonly number[];
}

function foldedTitleOf(title: string): FoldedTitle {
  const originalStarts: number[] = [];
  const foldedStarts: number[] = [];
  let originalOffset = 0;
  let foldedOffset = 0;
  let text = '';
  for (const char of title) {
    originalStarts.push(originalOffset);
    foldedStarts.push(foldedOffset);
    const folded = caseFold(char);
    text += folded;
    originalOffset += char.length;
    foldedOffset += folded.length;
  }
  originalStarts.push(originalOffset);
  foldedStarts.push(foldedOffset);
  return { text, originalStarts, foldedStarts };
}

/** The title character whose folded slice covers `position` of the folded text. */
function charIndexAt(foldedStarts: readonly number[], position: number): number {
  let index = 0;
  while (index + 2 < foldedStarts.length && (foldedStarts[index + 1] ?? 0) <= position) {
    index += 1;
  }
  return index;
}

/** The title's own `[start, end)` under a folded match at `[foldedStart, foldedEnd)`, rounded out to whole
 * characters. */
function originalRangeOf(
  folded: FoldedTitle,
  foldedStart: number,
  foldedEnd: number,
): readonly [number, number] {
  const from = charIndexAt(folded.foldedStarts, foldedStart);
  const to = charIndexAt(folded.foldedStarts, Math.max(foldedStart, foldedEnd - 1));
  return [
    folded.originalStarts[from] ?? 0,
    folded.originalStarts[to + 1] ?? folded.originalStarts.at(-1) ?? 0,
  ];
}

/**
 * Cuts `title` into plain and matched runs for the terms of a search (case-insensitive, as the filter matches,
 * including the Turkish İ/I/ı/i fold, #945). Pure and markup-free: the caller renders each run as text, so GitHub's
 * title never becomes HTML. Overlapping or touching hits merge into one run; no terms give the whole title as one
 * plain run.
 */
export function highlightSegments(title: string, terms: readonly string[]): readonly TitleSegment[] {
  const needles = terms
    .map((term) => caseFold(term))
    .filter((term) => term !== '')
    .sort((a, b) => b.length - a.length);
  if (needles.length === 0 || title === '') {
    return [{ text: title, isMatch: false }];
  }
  const folded = foldedTitleOf(title);
  const pattern = new RegExp(needles.map(escapeRegExp).join('|'), 'g');
  const segments: TitleSegment[] = [];
  let cursor = 0;
  for (const hit of folded.text.matchAll(pattern)) {
    const [original, originalEnd] = originalRangeOf(folded, hit.index, hit.index + hit[0].length);
    const start = Math.max(cursor, original);
    const end = Math.max(start, originalEnd);
    if (end <= start) {
      continue;
    }
    const previous = segments[segments.length - 1];
    if (start > cursor) {
      segments.push({ text: title.slice(cursor, start), isMatch: false });
    }
    if (start === cursor && previous?.isMatch === true) {
      segments[segments.length - 1] = { text: previous.text + title.slice(start, end), isMatch: true };
    } else {
      segments.push({ text: title.slice(start, end), isMatch: true });
    }
    cursor = end;
  }
  if (cursor < title.length) {
    segments.push({ text: title.slice(cursor), isMatch: false });
  }
  return segments.length === 0 ? [{ text: title, isMatch: false }] : segments;
}
