import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport, reducedMotion } from '../../../.storybook/stories';
import { Chip } from '../chip/chip';
import { Icon } from '../icon/icon';
import { List, ListRow } from './list';

const projects = `
  <tc-list aria-label="Проекты">
    <tc-list-row button current>
      <tc-icon tc-row-leading name="inbox" />
      <span tc-row-title>Team Console</span>
      <span tc-row-subtitle>Спринт 01 · демо 16 октября</span>
      <tc-chip tc-row-trailing tone="accent">3</tc-chip>
    </tc-list-row>
    <tc-list-row button>
      <tc-icon tc-row-leading name="inbox" />
      <span tc-row-title>Sheltrix</span>
      <span tc-row-subtitle>На паузе с 12 сентября — ждём решения по оплате домена</span>
      <tc-chip tc-row-trailing tone="warning" dot>Пауза</tc-chip>
    </tc-list-row>
    <tc-list-row href="#settings">
      <tc-icon tc-row-leading name="settings" />
      <span tc-row-title>Настройки</span>
      <tc-icon tc-row-trailing name="chevron-right" />
    </tc-list-row>
    <tc-list-row>
      <span tc-row-title>Версия 0.1.0</span>
      <span tc-row-subtitle>Статичная строка без действия</span>
    </tc-list-row>
    <tc-list-row button disabled>
      <span tc-row-title>Архив</span>
      <span tc-row-subtitle>Недоступно офлайн</span>
    </tc-list-row>
  </tc-list>
`;

const sidebar = `
  <div style="width: var(--sidebar-w); padding: var(--space-2); background: var(--bg-sunken); border-radius: var(--r-lg)">
    <tc-list plain aria-label="Проекты">
      <tc-list-row button current>
        <span tc-row-title>Team Console</span>
        <tc-chip tc-row-trailing tone="accent">3</tc-chip>
      </tc-list-row>
      <tc-list-row button>
        <span tc-row-title>Sheltrix</span>
      </tc-list-row>
      <tc-list-row button>
        <span tc-row-title>Reader</span>
      </tc-list-row>
    </tc-list>
  </div>
`;

const meta: Meta<List> = {
  title: 'Kit/List',
  component: List,
  decorators: [moduleMetadata({ imports: [List, ListRow, Chip, Icon] })],
  render: () => ({ template: projects }),
};

export default meta;
type Story = StoryObj<List>;

export const Rows: Story = {};
export const Sidebar: Story = { render: () => ({ template: sidebar }) };
export const Dark: Story = { ...darkTheme };
export const ReducedMotion: Story = { ...reducedMotion };
export const Phone: Story = { ...phoneViewport };
