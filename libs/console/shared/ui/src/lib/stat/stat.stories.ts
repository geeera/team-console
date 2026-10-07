import { TranslocoPipe } from '@console/shared/i18n';
import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport, reducedMotion } from '../../../.storybook/stories';
import { Stat, Stats } from './stat';

const numbers = `
  <dl tc-stats>
    <div tc-stat [label]="'stories.stat.done' | transloco">{{ 'stories.stat.doneValue' | transloco }}</div>
    <div tc-stat [label]="'stories.stat.prs' | transloco">2</div>
    <div tc-stat [label]="'stories.stat.ci' | transloco" tone="success">{{ 'stories.stat.green' | transloco }}</div>
    <div tc-stat [label]="'stories.stat.runs' | transloco" tone="danger">{{ 'stories.stat.failed' | transloco }}</div>
  </dl>
`;

/** The board's status tiles (#275): a sub line, tiles that jump to their list, a value too long for its tile. */
const tiles = `
  <dl tc-stats>
    <div tc-stat [label]="'stories.stat.done' | transloco" [sub]="'stories.stat.stillOpen' | transloco">
      {{ 'stories.stat.doneValue' | transloco }}
    </div>
    <div tc-stat tone="danger" [label]="'stories.stat.ci' | transloco" [actionLabel]="'stories.stat.ciAction' | transloco">
      {{ 'stories.stat.ciFailed' | transloco }}
    </div>
    <div tc-stat [label]="'stories.stat.runs' | transloco" [actionLabel]="'stories.stat.runsAction' | transloco">
      {{ 'stories.stat.running' | transloco }}
    </div>
    <div tc-stat [label]="'stories.stat.waiting' | transloco" [actionLabel]="'stories.stat.waitingAction' | transloco">
      {{ 'stories.stat.waitingValue' | transloco }}
    </div>
    <div tc-stat [label]="'stories.stat.long' | transloco">{{ 'stories.stat.longValue' | transloco }}</div>
  </dl>
`;

const meta: Meta<Stat> = {
  title: 'Kit/Stat',
  component: Stat,
  decorators: [moduleMetadata({ imports: [Stat, Stats, TranslocoPipe] })],
  argTypes: { tone: { control: 'select', options: ['neutral', 'success', 'danger'] } },
  args: { label: 'Open PRs', tone: 'neutral', sub: null, actionLabel: null },
  render: (args) => ({
    props: args,
    template: `<dl tc-stats><div tc-stat [label]="label" [tone]="tone" [sub]="sub" [actionLabel]="actionLabel">2</div></dl>`,
  }),
};

export default meta;
type Story = StoryObj<Stat>;

export const Playground: Story = {};
export const Tones: Story = { render: () => ({ template: numbers }) };
export const Dark: Story = { ...darkTheme, render: () => ({ template: numbers }) };
export const ReducedMotion: Story = { ...reducedMotion, render: () => ({ template: numbers }) };
export const Phone: Story = { ...phoneViewport, render: () => ({ template: numbers }) };
export const Tiles: Story = { render: () => ({ template: tiles }) };
export const TilesDark: Story = { ...darkTheme, render: () => ({ template: tiles }) };
export const TilesPhone: Story = { ...phoneViewport, render: () => ({ template: tiles }) };
