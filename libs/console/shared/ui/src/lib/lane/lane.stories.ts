import { TranslocoPipe } from '@console/shared/i18n';
import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport, reducedMotion } from '../../../.storybook/stories';
import { Chip } from '../chip/chip';
import { List, ListRow } from '../list/list';
import { StateBlock } from '../state-block/state-block';
import { Lane, Lanes } from './lane';

const row = (n: number, title: string, tier: string, tone: string) => `
  <tc-list-row>
    <span tc-row-leading>#${n}</span>
    <span tc-row-title>{{ 'stories.lane.${title}' | transloco }}</span>
    <tc-chip tc-row-trailing tone="${tone}">{{ 'stories.lane.${tier}' | transloco }}</tc-chip>
  </tc-list-row>
`;

const board = `
  <tc-lanes [attr.aria-label]="'stories.lane.aria' | transloco">
    <tc-lane [heading]="'stories.lane.progress' | transloco" [count]="2">
      <tc-list>
        ${row(49, 'autosave', 'heavy', 'warning')}
        ${row(52, 'tagFilter', 'standard', 'accent')}
      </tc-list>
    </tc-lane>
    <tc-lane [heading]="'stories.lane.qa' | transloco" [count]="0">
      <tc-state-block kind="empty" compact [title]="'stories.lane.empty' | transloco" />
    </tc-lane>
    <tc-lane [heading]="'stories.lane.done' | transloco" [count]="1">
      <tc-list>
        ${row(41, 'feed', 'light', 'neutral')}
      </tc-list>
    </tc-lane>
  </tc-lanes>
`;

const meta: Meta<Lane> = {
  title: 'Kit/Lane',
  component: Lane,
  decorators: [moduleMetadata({ imports: [Lane, Lanes, List, ListRow, Chip, StateBlock, TranslocoPipe] })],
  argTypes: { level: { control: 'select', options: [2, 3, 4] } },
  args: { heading: 'In progress', count: 2, level: 3 },
  render: (args) => ({
    props: args,
    template: `
      <tc-lane [heading]="heading" [count]="count" [level]="level">
        <tc-list>${row(49, 'autosave', 'heavy', 'warning')}${row(52, 'tagFilter', 'standard', 'accent')}</tc-list>
      </tc-lane>
    `,
  }),
};

export default meta;
type Story = StoryObj<Lane>;

export const Playground: Story = {};
/** Stacked on wider screens; on the phone the lanes become a sideways, snapping row. */
export const Board: Story = { render: () => ({ template: board }) };
export const Dark: Story = { ...darkTheme, render: () => ({ template: board }) };
export const ReducedMotion: Story = { ...reducedMotion, render: () => ({ template: board }) };
export const Phone: Story = { ...phoneViewport, render: () => ({ template: board }) };
