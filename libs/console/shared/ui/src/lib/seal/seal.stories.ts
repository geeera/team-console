import { TranslocoPipe } from '@console/shared/i18n';
import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport } from '../../../.storybook/stories';
import { Seal } from './seal';

const meta: Meta<Seal> = {
  title: 'Kit/Seal',
  component: Seal,
  decorators: [moduleMetadata({ imports: [Seal, TranslocoPipe] })],
  argTypes: { icon: { control: 'select', options: ['lock', 'check', 'clock'] } },
  args: { icon: 'lock' },
  render: (args) => ({
    props: args,
    template: `<tc-seal [icon]="icon" [label]="'stories.seal.label' | transloco" />`,
  }),
};

export default meta;
type Story = StoryObj<Seal>;

export const Playground: Story = {};
/** Beside a name, as on a repository row (#348). */
export const BesideAName: Story = {
  render: () => ({
    template: `
      <span style="display: inline-flex; align-items: center; gap: var(--space-2)">
        geeera/fieldnote
        <tc-seal icon="lock" [label]="'stories.seal.label' | transloco" />
      </span>
    `,
  }),
};
export const Dark: Story = { ...darkTheme };
export const Phone: Story = { ...phoneViewport };
