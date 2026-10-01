import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport, reducedMotion } from '../../../.storybook/stories';
import { Spinner } from '../spinner/spinner';
import { Icon } from './icon';

const names = [
  'check',
  'x',
  'minus',
  'chevron-right',
  'chevron-left',
  'chevron-down',
  'alert',
  'inbox',
  'search',
  'plus',
  'settings',
  'github',
  'pin',
  'grid',
  'chat',
  'board',
  'stack',
  'play',
  'archive',
  'external',
  'copy',
  'link',
  'help',
  'offline',
  'calendar',
];

const sheet = `
  <div style="display: flex; flex-wrap: wrap; gap: var(--space-4); align-items: center; color: var(--text-2)">
    ${names.map((name) => `<tc-icon name="${name}" size="lg" label="${name}" />`).join('')}
    <tc-spinner />
    <tc-spinner size="lg" />
  </div>
`;

const meta: Meta<Icon> = {
  title: 'Kit/Icon',
  component: Icon,
  decorators: [moduleMetadata({ imports: [Icon, Spinner] })],
  render: () => ({ template: sheet }),
};

export default meta;
type Story = StoryObj<Icon>;

export const Glyphs: Story = {};
export const Dark: Story = { ...darkTheme };
export const ReducedMotion: Story = { ...reducedMotion };
export const Phone: Story = { ...phoneViewport };
