import { TranslocoPipe } from '@console/shared/i18n';
import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport, reducedMotion } from '../../../.storybook/stories';
import { Chip } from '../chip/chip';
import { List, ListRow } from '../list/list';
import { TabPanel, Tabs } from './tabs';

const row = (n: number, title: string, chip: string, tone: string) => `
  <tc-list-row>
    <span tc-row-leading>#${n}</span>
    <span tc-row-title>{{ 'stories.tabs.${title}' | transloco }}</span>
    <tc-chip tc-row-trailing tone="${tone}">{{ 'stories.tabs.${chip}' | transloco }}</tc-chip>
  </tc-list-row>
`;

const sections = (enabled: boolean, selected = 'tasks') => `
  <tc-tabs [label]="'stories.tabs.aria' | transloco" [enabled]="${enabled}" selected="${selected}">
    <tc-tab-panel key="tasks" [label]="'stories.tabs.tasks' | transloco">
      <tc-list>${row(10, 'dialogs', 'heavy', 'warning')}${row(11, 'questions', 'standard', 'accent')}</tc-list>
    </tc-tab-panel>
    <tc-tab-panel key="pulls" [label]="'stories.tabs.pulls' | transloco">
      <tc-list>${row(40, 'requests', 'ciFailed', 'danger')}${row(92, 'bundle', 'ciRunning', 'warning')}</tc-list>
    </tc-tab-panel>
    <tc-tab-panel key="runs" [label]="'stories.tabs.runs' | transloco">
      <tc-list>${row(1, 'dev', 'finished', 'success')}</tc-list>
    </tc-tab-panel>
  </tc-tabs>
`;

const meta: Meta<Tabs> = {
  title: 'Kit/Tabs',
  component: Tabs,
  decorators: [moduleMetadata({ imports: [Tabs, TabPanel, List, ListRow, Chip, TranslocoPipe] })],
  render: () => ({ template: sections(true) }),
};

export default meta;
type Story = StoryObj<Tabs>;

/** A segmented tab list (←/→, Home, End; Tab goes into the panel) over one section at a time. */
export const Default: Story = {};
export const SecondSelected: Story = { render: () => ({ template: sections(true, 'pulls') }) };
/** Turned off on a wide screen: every section is a plain block, laid out by the page. */
export const Off: Story = { render: () => ({ template: sections(false) }) };
export const Dark: Story = { ...darkTheme };
export const ReducedMotion: Story = { ...reducedMotion };
export const Phone: Story = { ...phoneViewport };
