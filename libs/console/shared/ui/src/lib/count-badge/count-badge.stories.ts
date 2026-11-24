import { TranslocoPipe } from '@console/shared/i18n';
import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport, reducedMotion } from '../../../.storybook/stories';
import { Button } from '../button/button';
import { List, ListRow } from '../list/list';
import { CountBadge } from './count-badge';

/** The badge in its row: one answer lowers the count; at zero the pill shrinks into a dot and goes. */
const row = `
  <tc-list plain>
    <tc-list-row button>
      <span tc-row-title>{{ 'stories.countBadge.row' | transloco }}</span>
      <tc-count-badge tc-row-trailing [count]="count" [text]="'' + count" [label]="('stories.countBadge.label' | transloco) + ' ' + count" />
    </tc-list-row>
  </tc-list>
  <p>
    <button tc-button size="sm" type="button" (click)="count = count > 0 ? count - 1 : 3">{{ 'stories.countBadge.answer' | transloco }}</button>
  </p>
`;

const meta: Meta<CountBadge> = {
  title: 'Kit/CountBadge',
  component: CountBadge,
  decorators: [moduleMetadata({ imports: [Button, CountBadge, List, ListRow, TranslocoPipe] })],
  render: () => ({ props: { count: 2 }, template: row }),
};

export default meta;
type Story = StoryObj<CountBadge>;

/** Press the button: the number rolls down; at 0 the pill shrinks and leaves; once more brings it back at 3. */
export const Playground: Story = {};
/** No waiting items: nothing is drawn and the row's trailing slot is closed. */
export const Empty: Story = { render: () => ({ props: { count: 0 }, template: row }) };
export const Dark: Story = { ...darkTheme };
/** Reduced motion: the number changes at once and the pill fades out. */
export const ReducedMotion: Story = { ...reducedMotion };
export const Phone: Story = { ...phoneViewport };
