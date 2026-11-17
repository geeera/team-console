import type { ArtifactDto } from '@shared/contracts';
import type { IssueRecord } from '../github-records';
import { byRecentIssue, issueArtifactOf, type ContentsEntry } from './common';

/** The plugin's design stages (`reference/workflow.md`): an issue carrying any of them is a design artifact. */
export const DESIGN_LABELS = ['ux-spec', 'design:awaiting-approval', 'design:approved'] as const;

const AWAITING_APPROVAL_LABEL: (typeof DESIGN_LABELS)[number] = 'design:awaiting-approval';

export const DESIGN_DIR = 'docs/design';

const DESIGN_FILE = /\.(html|md)$/i;

export interface DesignInput {
  /** Issues from the label reads; the same issue may arrive under several labels. */
  readonly issues: readonly IssueRecord[];
  /** Every entry under docs/design, from one Git tree read (#770): no sub-folder cap, so nothing by name is skipped. */
  readonly files: readonly ContentsEntry[];
  /** project.yml's `design.storybook_url`, already limited to github.com. */
  readonly storybookUrl: string | null;
}

/**
 * `277-viewer/src/build.js` under docs/design is a generator source, not an artifact (same rule as `designFilesOf`
 * for one issue's files); `src` counts at any depth, not only directly under docs/design.
 */
function isGeneratorSource(path: string, prefix: string): boolean {
  return path.slice(prefix.length).split('/').includes('src');
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
    .filter(
      (entry) =>
        entry.kind === 'file' &&
        entry.htmlUrl !== null &&
        DESIGN_FILE.test(entry.name) &&
        !isGeneratorSource(entry.path, prefix),
    )
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
