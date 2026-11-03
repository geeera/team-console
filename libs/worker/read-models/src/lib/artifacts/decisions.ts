import type { ArtifactDto } from '@shared/contracts';
import type { ContentsEntry } from './common';

/**
 * Decisions: the Markdown files of project.yml's `decisions_dir`, titled by their first `#` heading. One read per
 * title, so a fill reads at most this many files (the Worker's 50-subrequest cap) and lists the rest by file name.
 */
export const DECISION_TITLE_READS = 30;

const TITLE_MAX_LENGTH = 200;

/** The decision files of a listing, newest record first (ADRs are numbered, so by name, descending). */
export function decisionFilesOf(entries: readonly ContentsEntry[]): ContentsEntry[] {
  return entries
    .filter(
      (entry) =>
        entry.kind === 'file' &&
        entry.htmlUrl !== null &&
        /\.md$/i.test(entry.name) &&
        entry.name.toLowerCase() !== 'readme.md',
    )
    .sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
}

/** The text of the first level-1 ATX heading outside a code fence, or `null`. */
export function firstHeadingOf(markdown: string): string | null {
  let inFence = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    const heading = inFence ? null : /^\s{0,3}#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (heading?.[1] !== undefined) {
      return heading[1].trim().slice(0, TITLE_MAX_LENGTH);
    }
  }
  return null;
}

function fileTitle(name: string): string {
  return name.replace(/\.md$/i, '');
}

/** `titles` maps a path to its heading; a file without one (unread, unreadable, no heading) shows its name. */
export function decisionArtifactsOf(
  files: readonly ContentsEntry[],
  titles: ReadonlyMap<string, string | null>,
): ArtifactDto[] {
  return files.flatMap((file) =>
    file.htmlUrl === null
      ? []
      : [
          {
            type: 'decision' as const,
            title: titles.get(file.path) ?? fileTitle(file.name),
            url: file.htmlUrl,
            updatedAt: null,
            source: 'file' as const,
            state: null,
          },
        ],
  );
}
