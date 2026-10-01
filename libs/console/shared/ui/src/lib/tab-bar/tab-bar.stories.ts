import { TranslocoPipe } from '@console/shared/i18n';
import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport, reducedMotion } from '../../../.storybook/stories';
import { Icon } from '../icon/icon';
import { Tab, TabBar } from './tab-bar';

const segmented = `
  <nav tc-tab-bar [attr.aria-label]="'stories.tabBar.aria' | transloco">
    <a tc-tab href="#questions" current><tc-icon name="inbox" />{{ 'stories.tabBar.questions' | transloco }}</a>
    <a tc-tab href="#chat"><tc-icon name="chat" />{{ 'stories.tabBar.chat' | transloco }}</a>
    <a tc-tab href="#board"><tc-icon name="board" />{{ 'stories.tabBar.board' | transloco }}</a>
    <a tc-tab href="#artifacts"><tc-icon name="stack" />{{ 'stories.tabBar.artifacts' | transloco }}</a>
  </nav>
`;

const bottom = `
  <div style="display: flex; flex-direction: column; height: var(--pane-w); border: var(--border-w) solid var(--border); border-radius: var(--r-lg); overflow: hidden">
    <div style="flex: 1"></div>
    <nav tc-tab-bar bottom [attr.aria-label]="'stories.tabBar.aria' | transloco">
      <a tc-tab href="#questions"><tc-icon name="inbox" size="lg" />{{ 'stories.tabBar.questions' | transloco }}</a>
      <a tc-tab href="#chat" current><tc-icon name="chat" size="lg" />{{ 'stories.tabBar.chat' | transloco }}</a>
      <a tc-tab href="#board"><tc-icon name="board" size="lg" />{{ 'stories.tabBar.board' | transloco }}</a>
      <a tc-tab href="#artifacts"><tc-icon name="stack" size="lg" />{{ 'stories.tabBar.artifacts' | transloco }}</a>
    </nav>
  </div>
`;

const meta: Meta<TabBar> = {
  title: 'Kit/TabBar',
  component: TabBar,
  decorators: [moduleMetadata({ imports: [TabBar, Tab, Icon, TranslocoPipe] })],
  render: () => ({ template: segmented }),
};

export default meta;
type Story = StoryObj<TabBar>;

export const Segmented: Story = {};
export const Bottom: Story = { render: () => ({ template: bottom }) };
export const Dark: Story = { ...darkTheme };
export const ReducedMotion: Story = { ...reducedMotion };
export const Phone: Story = { ...phoneViewport, render: () => ({ template: bottom }) };
