import { TranslocoPipe } from '@console/shared/i18n';
import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport, reducedMotion } from '../../../.storybook/stories';
import { Button, IconButton } from '../button/button';
import { Icon } from '../icon/icon';
import { TopBar } from './top-bar';
import { TopBarAction } from './top-bar-action';

const bar = `
  <header tc-top-bar>
    <button tc-icon-button tc-top-bar-leading type="button" [attr.aria-label]="'ui.back' | transloco"><tc-icon name="chevron-left" size="lg" /></button>
    <h1 tc-top-bar-title>{{ 'stories.common.settings' | transloco }}</h1>
    <button tc-icon-button tc-top-bar-trailing type="button" [attr.aria-label]="'stories.topBar.search' | transloco"><tc-icon name="search" size="lg" /></button>
  </header>
`;

const meta: Meta<TopBar> = {
  title: 'Kit/Top bar',
  component: TopBar,
  decorators: [moduleMetadata({ imports: [TopBar, IconButton, Icon, TranslocoPipe] })],
  parameters: { layout: 'fullscreen' },
  render: () => ({ template: bar }),
};

export default meta;
type Story = StoryObj<TopBar>;

export const Default: Story = {};

export const TitleOnly: Story = {
  render: () => ({
    template: `<header tc-top-bar><h1 tc-top-bar-title>{{ 'stories.topBar.attention' | transloco }}</h1></header>`,
  }),
};

export const LongTitle: Story = {
  ...phoneViewport,
  render: () => ({
    template: `
      <header tc-top-bar>
        <button tc-icon-button tc-top-bar-leading type="button" [attr.aria-label]="'ui.back' | transloco"><tc-icon name="chevron-left" size="lg" /></button>
        <h1 tc-top-bar-title>{{ 'stories.topBar.longTitle' | transloco }}</h1>
      </header>
    `,
  }),
};

export const Dark: Story = { ...darkTheme };
export const ReducedMotion: Story = { ...reducedMotion };
export const Phone: Story = { ...phoneViewport };

/**
 * #114: a screen's own action next to the shell's (Commands in a project space). The page offers it with
 * `<ng-template tcTopBarAction>`; the shell renders `TopBarActions.template()` in its trailing slot.
 */
export const ScreenAction: Story = {
  ...phoneViewport,
  decorators: [moduleMetadata({ imports: [Button, TopBarAction] })],
  render: () => ({
    template: `
      <header tc-top-bar>
        <h1 tc-top-bar-title>storify</h1>
        <span tc-top-bar-trailing style="display: inline-flex; gap: var(--space-1); align-items: center">
          <button tc-button size="sm" type="button"><tc-icon name="sliders" size="sm" />{{ 'stories.topBar.commands' | transloco }}</button>
          <button tc-icon-button type="button" [attr.aria-label]="'stories.common.settings' | transloco"><tc-icon name="settings" size="lg" /></button>
        </span>
      </header>
    `,
  }),
};
