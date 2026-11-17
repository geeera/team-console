import { moduleMetadata, type Meta, type StoryObj } from '@storybook/angular';
import { SaveBar } from './save-bar';

interface Args {
  readonly count: number;
  readonly label: string;
  readonly offReason: string | null;
}

const meta: Meta<Args> = {
  title: 'Features/Team config/Save bar',
  decorators: [moduleMetadata({ imports: [SaveBar] })],
  render: (args) => ({
    props: args,
    template: `
      <div style="max-width: var(--page-max)">
        <tc-save-bar [count]="count" [label]="label" [offReason]="offReason" />
      </div>
    `,
  }),
  args: { count: 3, label: 'Несохранённые изменения', offReason: null },
};

export default meta;
type Story = StoryObj<Args>;

/** Three edits waiting: Review and save is the next action. */
export const Unsaved: Story = {};
/** One edit, in its singular form. */
export const OneChange: Story = { args: { count: 1 } };
/** Offline: Review and save stays focusable, off, with the reason under the count. */
export const Offline: Story = { args: { offReason: 'Нет сети: отправить нельзя.' } };
/** A typed value is out of its range. */
export const InvalidValue: Story = { args: { offReason: 'Исправьте значения с ошибками.' } };
