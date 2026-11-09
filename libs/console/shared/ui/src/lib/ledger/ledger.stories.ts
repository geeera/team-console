import { TranslocoPipe } from '@console/shared/i18n';
import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport, reducedMotion } from '../../../.storybook/stories';
import { PickerButton } from '../picker-button/picker-button';
import { Ledger, LedgerRow } from './ledger';

// The #409 field ledger on its own (#457): plain values, a value too long for one line, and a picker row.
const values = `
  <dl tc-ledger style="max-width: var(--task-pane-w)">
    <div tc-ledger-row [label]="'stories.ledger.status' | transloco">{{ 'stories.ledger.approved' | transloco }}</div>
    <div tc-ledger-row [label]="'stories.ledger.kind' | transloco">{{ 'stories.ledger.bug' | transloco }}</div>
    <div tc-ledger-row [label]="'stories.ledger.tier' | transloco">{{ 'stories.ledger.standard' | transloco }}</div>
    <div tc-ledger-row [label]="'stories.ledger.sprint' | transloco">{{ 'stories.ledger.sprintValue' | transloco }}</div>
  </dl>
`;

const long = `
  <dl tc-ledger style="max-width: var(--task-pane-w)">
    <div tc-ledger-row [label]="'stories.ledger.sprint' | transloco">{{ 'stories.ledger.longValue' | transloco }}</div>
    <div tc-ledger-row [label]="'stories.ledger.longLabel' | transloco">{{ 'stories.ledger.standard' | transloco }}</div>
  </dl>
`;

const withPicker = `
  <dl tc-ledger style="max-width: var(--task-pane-w)">
    <div tc-ledger-row [label]="'stories.ledger.status' | transloco">
      <button tc-picker type="button" [field]="'stories.ledger.status' | transloco"
        [value]="'stories.ledger.approved' | transloco"></button>
    </div>
    <div tc-ledger-row [label]="'stories.ledger.tier' | transloco">{{ 'stories.ledger.standard' | transloco }}</div>
  </dl>
`;

const meta: Meta<LedgerRow> = {
  title: 'Kit/Ledger',
  component: LedgerRow,
  decorators: [moduleMetadata({ imports: [Ledger, LedgerRow, PickerButton, TranslocoPipe] })],
  args: { label: 'Status' },
  render: (args) => ({
    props: args,
    template: `<dl tc-ledger style="max-width: var(--task-pane-w)"><div tc-ledger-row [label]="label">Approved</div></dl>`,
  }),
};

export default meta;
type Story = StoryObj<LedgerRow>;

export const Playground: Story = {};
export const Values: Story = { render: () => ({ template: values }) };
export const LongValues: Story = { render: () => ({ template: long }) };
export const WithPicker: Story = { render: () => ({ template: withPicker }) };
export const Dark: Story = { ...darkTheme, render: () => ({ template: values }) };
export const ReducedMotion: Story = { ...reducedMotion, render: () => ({ template: values }) };
export const Phone: Story = { ...phoneViewport, render: () => ({ template: long }) };
