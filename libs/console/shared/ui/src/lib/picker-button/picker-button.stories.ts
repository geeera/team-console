import { TranslocoPipe } from '@console/shared/i18n';
import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport, reducedMotion } from '../../../.storybook/stories';
import { Ledger, LedgerRow } from '../ledger/ledger';
import { Menu } from '../menu/menu';
import { PickerButton } from './picker-button';

// The #409 field ledger with its pickers: a picker opens the kit Menu (a popover here, a sheet on the phone).
const ledger = `
  <dl tc-ledger style="max-width: var(--task-pane-w)">
    <div tc-ledger-row [label]="'stories.ledger.status' | transloco">
      <button tc-picker type="button" [field]="'stories.ledger.status' | transloco"
        [value]="'stories.ledger.approved' | transloco"></button>
    </div>
    <div tc-ledger-row [label]="'stories.ledger.kind' | transloco">
      <button tc-picker type="button" [field]="'stories.ledger.kind' | transloco"
        [value]="'stories.ledger.bug' | transloco" off aria-describedby="story-off"></button>
      <small id="story-off">{{ 'stories.ledger.offline' | transloco }}</small>
    </div>
    <div tc-ledger-row [label]="'stories.ledger.tier' | transloco">{{ 'stories.ledger.standard' | transloco }}</div>
  </dl>
`;

const meta: Meta<PickerButton> = {
  title: 'Kit/Ledger and PickerButton',
  component: PickerButton,
  decorators: [
    moduleMetadata({ imports: [Ledger, LedgerRow, PickerButton, TranslocoPipe], providers: [Menu] }),
  ],
  render: () => ({ template: ledger }),
};

export default meta;
type Story = StoryObj<PickerButton>;

export const Ledger_: Story = { name: 'Ledger' };
export const Open: Story = {
  render: () => ({
    template: `<button tc-picker type="button" expanded [field]="'stories.ledger.status' | transloco"
      [value]="'stories.ledger.approved' | transloco"></button>`,
  }),
};
export const Dark: Story = { ...darkTheme };
export const ReducedMotion: Story = { ...reducedMotion };
export const Phone: Story = { ...phoneViewport };
