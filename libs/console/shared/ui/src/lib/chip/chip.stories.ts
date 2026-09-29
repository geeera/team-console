import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme, reducedMotion } from '../../../.storybook/stories';
import { Chip } from './chip';

const allTones = `
  <div style="display: flex; flex-wrap: wrap; gap: var(--space-2)">
    <tc-chip>Черновик</tc-chip>
    <tc-chip tone="accent">3 вопроса</tc-chip>
    <tc-chip tone="success" dot>Активен</tc-chip>
    <tc-chip tone="warning" dot>На паузе</tc-chip>
    <tc-chip tone="danger" dot>Сборка падает</tc-chip>
  </div>
`;

const meta: Meta<Chip> = {
  title: 'Kit/Chip',
  component: Chip,
  decorators: [moduleMetadata({ imports: [Chip] })],
  argTypes: { tone: { control: 'select', options: ['neutral', 'accent', 'success', 'warning', 'danger'] } },
  args: { tone: 'success', dot: true },
  render: (args) => ({ props: args, template: `<tc-chip [tone]="tone" [dot]="dot">Активен</tc-chip>` }),
};

export default meta;
type Story = StoryObj<Chip>;

export const Playground: Story = {};
export const Tones: Story = { render: () => ({ template: allTones }) };
export const Dark: Story = { ...darkTheme, render: () => ({ template: allTones }) };
export const ReducedMotion: Story = { ...reducedMotion, render: () => ({ template: allTones }) };
