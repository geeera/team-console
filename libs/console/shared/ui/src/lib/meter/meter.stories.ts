import { TranslocoPipe } from '@console/shared/i18n';
import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport } from '../../../.storybook/stories';
import { Meter } from './meter';

// The meter never stands alone: the text beside it carries the number.
const states = `
  <div style="display: grid; gap: var(--space-3)">
    @for (row of [[0, 8], [3, 8], [8, 8], [0, 0]]; track $index) {
      <div style="display: grid; gap: var(--space-1)">
        <span style="font-size: var(--fs-xs); color: var(--text-2)">
          {{ 'stories.meter.done' | transloco: { done: row[0], total: row[1] } }}
        </span>
        <tc-meter [value]="row[0]" [max]="row[1]" />
      </div>
    }
  </div>
`;

const meta: Meta<Meter> = {
  title: 'Kit/Meter',
  component: Meter,
  decorators: [moduleMetadata({ imports: [Meter, TranslocoPipe] })],
  args: { value: 3, max: 8 },
  render: (args) => ({
    props: args,
    template: `<tc-meter [value]="value" [max]="max" />`,
  }),
};

export default meta;
type Story = StoryObj<Meter>;

export const Playground: Story = {};
export const States: Story = { render: () => ({ template: states }) };
export const Dark: Story = { ...darkTheme, render: () => ({ template: states }) };
export const Phone: Story = { ...phoneViewport, render: () => ({ template: states }) };
