import type { ArtifactDto } from '@shared/contracts';
import type { IssueRecord } from '../github-records';
import { byRecentIssue, issueArtifactOf, type ContentsEntry } from './common';

/** The plugin's design stages (`reference/workflow.md`): an issue carrying any of them is a design artifact. */
export const DESIGN_LABELS = ['ux-spec', 'design:awaiting-approval', 'design:approved'] as const;

const AWAITING_APPROVAL_LABEL: (typeof DESIGN_LABELS)[number] = 'design:awaiting-approval';

export const DESIGN_DIR = 'docs/design';

/**
 * docs/design is listed one level deep: the folder itself and at most this many sub-folders (one read each).
 * Generator sources (`src`) are not artifacts.
 */
export const DESIGN_SUBFOLDER_READS = 5;

const DESIGN_FILE = /\.(html|md)$/i;

/** The sub-folders of docs/design worth listing, in name order. */
export function designFoldersOf(entries: readonly ContentsEntry[]): ContentsEntry[] {
  return entries
    .filter((entry) => entry.kind === 'dir' && entry.name !== 'src')
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export interface DesignInput {
  /** Issues from the label reads; the same issue may arrive under several labels. */
  readonly issues: readonly IssueRecord[];
  /** Entries of docs/design and its listed sub-folders. */
  readonly files: readonly ContentsEntry[];
  /** project.yml's `design.storybook_url`, already limited to github.com. */
  readonly storybookUrl: string | null;
}

export function designArtifactsOf(input: DesignInput): ArtifactDto[] {
  const seen = new Set<number>();
  const issues = input.issues
    .filter((issue) => {
      const isDesign = issue.labels.some((label) => (DESIGN_LABELS as readonly string[]).includes(label));
      if (!isDesign || seen.has(issue.number)) {
        return false;
      }
      seen.add(issue.number);
      return true;
    })
    .sort(byRecentIssue)
    .flatMap((issue): ArtifactDto[] => {
      const artifact = issueArtifactOf('design', issue);
      if (artifact === null) {
        return [];
      }
      // #277: the viewer opens by issue number; the row says when the plugin waits for the owner's approval.
      return [
        {
          ...artifact,
          number: issue.number,
          awaitingApproval: issue.state === 'open' && issue.labels.includes(AWAITING_APPROVAL_LABEL),
        },
      ];
    });

  const prefix = `${DESIGN_DIR}/`;
  const files = input.files
    .filter((entry) => entry.kind === 'file' && entry.htmlUrl !== null && DESIGN_FILE.test(entry.name))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((entry): ArtifactDto => ({
      type: 'design',
      title: entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.path,
      url: entry.htmlUrl ?? '',
      updatedAt: null,
      source: 'file',
      state: null,
    }));

  const storybook: ArtifactDto[] =
    input.storybookUrl === null
      ? []
      : [
          {
            type: 'design',
            title: 'Storybook',
            url: input.storybookUrl,
            updatedAt: null,
            source: 'config',
            state: null,
          },
        ];
  return [...issues, ...files, ...storybook];
}
