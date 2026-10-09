import { TranslocoPipe } from '@console/shared/i18n';
import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport, reducedMotion } from '../../../.storybook/stories';
import { Button } from '../button/button';
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
  <tc-lanes [label]="'stories.lane.aria' | transloco">
    <tc-lane key="in-progress" [heading]="'stories.lane.progress' | transloco" [count]="2">
      <tc-list>
        ${row(49, 'autosave', 'heavy', 'warning')}
        ${row(52, 'tagFilter', 'standard', 'accent')}
      </tc-list>
    </tc-lane>
    <tc-lane key="qa" [heading]="'stories.lane.qa' | transloco" [count]="0">
      <tc-state-block kind="empty" compact [title]="'stories.lane.empty' | transloco" />
    </tc-lane>
    <tc-lane key="done" [heading]="'stories.lane.done' | transloco" [count]="1">
      <tc-list>
        ${row(41, 'feed', 'light', 'neutral')}
      </tc-list>
    </tc-lane>
  </tc-lanes>
`;

/** The sprint board's five lanes (#275): one row on the phone, opening on the blockers; Done folded on a wide screen. */
const fiveLanes = `
  <tc-lanes [label]="'stories.lane.aria' | transloco" [preferred]="['blocked', 'in-progress']">
    <tc-lane key="approved" [heading]="'stories.lane.approved' | transloco" [count]="1">
      <tc-list>${row(41, 'feed', 'light', 'neutral')}</tc-list>
    </tc-lane>
    <tc-lane key="in-progress" [heading]="'stories.lane.progress' | transloco" [count]="1">
      <tc-list>${row(49, 'autosave', 'heavy', 'warning')}</tc-list>
    </tc-lane>
    <tc-lane key="qa" [heading]="'stories.lane.qa' | transloco" [count]="0">
      <tc-state-block kind="empty" compact [title]="'stories.lane.empty' | transloco" />
    </tc-lane>
    <tc-lane key="blocked" [heading]="'stories.lane.blocked' | transloco" [count]="1">
      <tc-list>${row(52, 'tagFilter', 'standard', 'accent')}</tc-list>
    </tc-lane>
    <tc-lane key="done" [heading]="'stories.lane.done' | transloco" [count]="10">
      <button tc-lane-action tc-button size="sm" type="button">{{ 'stories.lane.show' | transloco }}</button>
    </tc-lane>
  </tc-lanes>
`;

const meta: Meta<Lane> = {
  title: 'Kit/Lane',
  component: Lane,
  decorators: [
    moduleMetadata({ imports: [Button, Lane, Lanes, List, ListRow, Chip, StateBlock, TranslocoPipe] }),
  ],
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

/** A board with only one lane, as a backlog with nothing but "No status": no switcher, the heading stays. */
const single = `
  <tc-lanes [label]="'stories.lane.aria' | transloco">
    <tc-lane key="in-progress" [heading]="'stories.lane.progress' | transloco" [count]="2">
      <tc-list>
        ${row(49, 'autosave', 'heavy', 'warning')}
        ${row(52, 'tagFilter', 'standard', 'accent')}
      </tc-list>
    </tc-lane>
  </tc-lanes>
`;

export const Playground: Story = {};
/** Stacked on wider screens. */
export const Board: Story = { render: () => ({ template: board }) };
export const Dark: Story = { ...darkTheme, render: () => ({ template: board }) };
export const ReducedMotion: Story = { ...reducedMotion, render: () => ({ template: board }) };
/**
 * On the phone a one-row switcher of toggle buttons (name above count, an empty lane dimmed) shows one lane at a time,
 * at its own height. It opens on the first lane with items; the next lane slides in from the side moved towards.
 */
export const Phone: Story = { ...phoneViewport, render: () => ({ template: board }) };
export const PhoneDark: Story = {
  globals: { ...phoneViewport.globals, ...darkTheme.globals },
  render: () => ({ template: board }),
};
/** Reduced motion: the incoming lane fades in, without the slide. */
export const PhoneReducedMotion: Story = {
  globals: { ...phoneViewport.globals, ...reducedMotion.globals },
  render: () => ({ template: board }),
};
export const PhoneSingleLane: Story = { ...phoneViewport, render: () => ({ template: single }) };
/** Five lanes stay one row at 390 px; the empty one is dimmed. */
export const PhoneFiveLanes: Story = { ...phoneViewport, render: () => ({ template: fiveLanes }) };
/** A wide screen stacks them; a lane can carry an action beside its heading (Done's Show). */
export const FiveLanes: Story = { render: () => ({ template: fiveLanes }) };
