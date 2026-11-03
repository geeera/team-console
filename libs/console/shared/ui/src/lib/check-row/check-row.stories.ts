import { TranslocoPipe } from '@console/shared/i18n';
import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport } from '../../../.storybook/stories';
import { List } from '../list/list';
import { CheckRow } from './check-row';

const rows = (disabled: boolean): string => `
  <tc-list [attr.aria-label]="'stories.checkRow.list' | transloco">
    <tc-check-row [checked]="true" ${disabled ? 'disabled' : ''}>
      <span tc-check-title>#72 {{ 'stories.checkRow.first' | transloco }}</span>
      <span tc-check-detail>{{ 'stories.checkRow.detail' | transloco }}</span>
    </tc-check-row>
    <tc-check-row ${disabled ? 'disabled' : ''}>
      <span tc-check-title>#81 {{ 'stories.checkRow.second' | transloco }}</span>
      <span tc-check-detail>{{ 'stories.checkRow.detail' | transloco }}</span>
    </tc-check-row>
    <tc-check-row [checked]="true" ${disabled ? 'disabled' : ''}>
      <span tc-check-title>#90 {{ 'stories.checkRow.long' | transloco }}</span>
    </tc-check-row>
  </tc-list>
`;

const meta: Meta<CheckRow> = {
  title: 'Kit/CheckRow',
  component: CheckRow,
  decorators: [moduleMetadata({ imports: [CheckRow, List, TranslocoPipe] })],
  render: () => ({ template: rows(false) }),
};

export default meta;
type Story = StoryObj<CheckRow>;

export const Default: Story = {};
export const Disabled: Story = { render: () => ({ template: rows(true) }) };
export const Dark: Story = { ...darkTheme };
export const Phone: Story = { ...phoneViewport };
