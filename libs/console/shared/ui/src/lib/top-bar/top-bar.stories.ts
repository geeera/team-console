import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport, reducedMotion } from '../../../.storybook/stories';
import { IconButton } from '../button/button';
import { Icon } from '../icon/icon';
import { TopBar } from './top-bar';

const bar = `
  <header tc-top-bar>
    <button tc-icon-button tc-top-bar-leading type="button" aria-label="Назад"><tc-icon name="chevron-left" size="lg" /></button>
    <h1 tc-top-bar-title>Настройки</h1>
    <button tc-icon-button tc-top-bar-trailing type="button" aria-label="Поиск"><tc-icon name="search" size="lg" /></button>
  </header>
`;

const meta: Meta<TopBar> = {
  title: 'Kit/Top bar',
  component: TopBar,
  decorators: [moduleMetadata({ imports: [TopBar, IconButton, Icon] })],
  parameters: { layout: 'fullscreen' },
  render: () => ({ template: bar }),
};

export default meta;
type Story = StoryObj<TopBar>;

export const Default: Story = {};

export const TitleOnly: Story = {
  render: () => ({ template: `<header tc-top-bar><h1 tc-top-bar-title>Нужно твоё внимание</h1></header>` }),
};

export const LongTitle: Story = {
  ...phoneViewport,
  render: () => ({
    template: `
      <header tc-top-bar>
        <button tc-icon-button tc-top-bar-leading type="button" aria-label="Назад"><tc-icon name="chevron-left" size="lg" /></button>
        <h1 tc-top-bar-title>Очень длинное название проекта, которое не помещается в строку</h1>
      </header>
    `,
  }),
};

export const Dark: Story = { ...darkTheme };
export const ReducedMotion: Story = { ...reducedMotion };
export const Phone: Story = { ...phoneViewport };
