import { TranslocoPipe } from '@console/shared/i18n';
import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport, reducedMotion } from '../../../.storybook/stories';
import { Chip } from '../chip/chip';
import { Icon } from '../icon/icon';
import { List, ListRow } from './list';

const projects = `
  <tc-list [attr.aria-label]="'stories.list.ariaProjects' | transloco">
    <tc-list-row button current>
      <tc-icon tc-row-leading name="inbox" />
      <span tc-row-title>Team Console</span>
      <span tc-row-subtitle>{{ 'stories.list.sprintLine' | transloco }}</span>
      <tc-chip tc-row-trailing tone="accent">3</tc-chip>
    </tc-list-row>
    <tc-list-row button>
      <tc-icon tc-row-leading name="inbox" />
      <span tc-row-title>Sheltrix</span>
      <span tc-row-subtitle>{{ 'stories.list.pausedSince' | transloco }}</span>
      <tc-chip tc-row-trailing tone="warning" dot>{{ 'stories.chip.paused' | transloco }}</tc-chip>
    </tc-list-row>
    <tc-list-row href="#settings">
      <tc-icon tc-row-leading name="settings" />
      <span tc-row-title>{{ 'stories.common.settings' | transloco }}</span>
      <tc-icon tc-row-trailing name="chevron-right" />
    </tc-list-row>
    <tc-list-row>
      <span tc-row-title>{{ 'stories.list.version' | transloco }}</span>
      <span tc-row-subtitle>{{ 'stories.list.staticRow' | transloco }}</span>
    </tc-list-row>
    <tc-list-row button disabled>
      <span tc-row-title>{{ 'stories.list.archive' | transloco }}</span>
      <span tc-row-subtitle>{{ 'stories.list.offline' | transloco }}</span>
    </tc-list-row>
  </tc-list>
`;

const sidebar = `
  <div style="width: var(--sidebar-w); padding: var(--space-2); background: var(--bg-sunken); border-radius: var(--r-lg)">
    <tc-list plain [attr.aria-label]="'stories.list.ariaProjects' | transloco">
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
  decorators: [moduleMetadata({ imports: [List, ListRow, Chip, Icon, TranslocoPipe] })],
  render: () => ({ template: projects }),
};

export default meta;
type Story = StoryObj<List>;

export const Rows: Story = {};
export const Sidebar: Story = { render: () => ({ template: sidebar }) };
export const Dark: Story = { ...darkTheme };
export const ReducedMotion: Story = { ...reducedMotion };
export const Phone: Story = { ...phoneViewport };
