import type { Meta, StoryObj } from '@storybook/angular';
import { darkTheme, phoneViewport, reducedMotion } from '../../../.storybook/stories';
import { LiveDot } from './live-dot';

const meta: Meta<LiveDot> = {
  title: 'Kit/LiveDot',
  component: LiveDot,
  args: { tone: 'accent', depth: 'soft', paused: false },
};

export default meta;
type Story = StoryObj<LiveDot>;

const variants = `
  <div style="display: flex; gap: var(--space-4); align-items: center">
    <tc-live-dot />
    <tc-live-dot tone="success" depth="deep" />
    <tc-live-dot paused />
  </div>
`;

export const Playground: Story = {};
/** Accent and soft (the team works), success and deep (a command run), and one paused (hidden tab). */
export const Variants: Story = { render: () => ({ template: variants }) };
export const Dark: Story = { ...darkTheme, render: () => ({ template: variants }) };
/** Reduced motion: the dot stays still at full strength. */
export const ReducedMotion: Story = { ...reducedMotion, render: () => ({ template: variants }) };
export const Phone: Story = { ...phoneViewport, render: () => ({ template: variants }) };
