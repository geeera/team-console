import { moduleMetadata, type Meta, type StoryObj } from '@storybook/angular';
import type { Artifact } from './artifact.model';
import { ArtifactList } from './artifact-list';

// The kit Storybook's toolbar globals (`.storybook/stories.ts`); repeated here rather than imported across projects.
const darkTheme = { globals: { theme: 'dark' } } satisfies Partial<StoryObj>;

const ITEMS: readonly Artifact[] = [
  {
    type: 'decision',
    title: 'Decision: release notes come from merged pull requests',
    url: 'https://github.com/geeera/team-console/blob/main/docs/adr/0007.md',
    updatedAt: '2026-11-02T00:00:00Z',
    source: 'file',
    state: null,
  },
  {
    type: 'demo',
    title: 'Sprint demo: board and release notes',
    url: 'https://github.com/geeera/team-console/issues/301',
    updatedAt: '2026-11-10T00:00:00Z',
    source: 'issue',
    state: 'open',
  },
];

interface Args {
  readonly highlight: readonly string[];
}

const meta: Meta<Args> = {
  title: 'Entities/Artifact list',
  decorators: [moduleMetadata({ imports: [ArtifactList] })],
  render: (args) => ({
    props: { ...args, items: ITEMS },
    template: `
      <div style="max-width: calc(var(--sidebar-w) * 2)">
        <tc-artifact-list label="Artifacts" [items]="items" [highlight]="highlight" />
      </div>
    `,
  }),
  args: { highlight: [] },
};

export default meta;
type Story = StoryObj<Args>;

export const Plain: Story = {};
/** A search for "release notes": each hit gets a marker bar drawn left to right (#362); instant under reduced motion. */
export const SearchHits: Story = { args: { highlight: ['release', 'notes'] } };
export const SearchHitsDark: Story = { args: { highlight: ['release', 'notes'] }, ...darkTheme };
