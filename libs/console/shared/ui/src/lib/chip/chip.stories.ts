import { TranslocoPipe } from '@console/shared/i18n';
import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport, reducedMotion } from '../../../.storybook/stories';
import { Chip } from './chip';

const allTones = `
  <div style="display: flex; flex-wrap: wrap; gap: var(--space-2)">
    <tc-chip>{{ 'stories.chip.draft' | transloco }}</tc-chip>
    <tc-chip tone="accent">{{ 'stories.chip.questions' | transloco }}</tc-chip>
    <tc-chip tone="success" dot>{{ 'stories.chip.active' | transloco }}</tc-chip>
    <tc-chip tone="warning" dot>{{ 'stories.chip.paused' | transloco }}</tc-chip>
    <tc-chip tone="danger" dot>{{ 'stories.chip.buildFailing' | transloco }}</tc-chip>
  </div>
`;

const meta: Meta<Chip> = {
  title: 'Kit/Chip',
  component: Chip,
  decorators: [moduleMetadata({ imports: [Chip, TranslocoPipe] })],
  argTypes: { tone: { control: 'select', options: ['neutral', 'accent', 'success', 'warning', 'danger'] } },
  args: { tone: 'success', dot: true },
  render: (args) => ({
    props: args,
    template: `<tc-chip [tone]="tone" [dot]="dot">{{ 'stories.chip.active' | transloco }}</tc-chip>`,
  }),
};

export default meta;
type Story = StoryObj<Chip>;

export const Playground: Story = {};
export const Tones: Story = { render: () => ({ template: allTones }) };
export const Dark: Story = { ...darkTheme, render: () => ({ template: allTones }) };
export const ReducedMotion: Story = { ...reducedMotion, render: () => ({ template: allTones }) };
export const Phone: Story = { ...phoneViewport, render: () => ({ template: allTones }) };
