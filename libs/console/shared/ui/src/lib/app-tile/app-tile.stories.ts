import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme } from '../../../.storybook/stories';
import { AppTile } from './app-tile';

const meta: Meta<AppTile> = {
  title: 'Kit/AppTile',
  component: AppTile,
  decorators: [moduleMetadata({ imports: [AppTile] })],
  render: () => ({
    template: `
      <div style="display: flex; align-items: center; gap: var(--space-4)">
        <tc-app-tile />
        <tc-app-tile small />
      </div>
    `,
  }),
};

export default meta;
type Story = StoryObj<AppTile>;

/** The card and settings row size, then the one-line size. */
export const Sizes: Story = {};
export const Dark: Story = { ...darkTheme };
