import { moduleMetadata, type Meta, type StoryObj } from '@storybook/angular';
import { ChangesTable, type ChangeRow } from './changes-table';

interface Args {
  readonly rows: readonly ChangeRow[];
}

const ROWS: readonly ChangeRow[] = [
  { path: 'roles.dev.model', label: 'Разработчик · модель', from: 'Opus 5.5', to: 'Fable 5.1' },
  { path: 'roles.ui-designer.enabled', label: 'UI-дизайнер', from: 'выключена', to: 'включена' },
  { path: 'budget.monthly_usd', label: 'Месячный бюджет', from: '200 $', to: '250 $' },
];

const meta: Meta<Args> = {
  title: 'Features/Team config/Diff table',
  decorators: [moduleMetadata({ imports: [ChangesTable] })],
  render: (args) => ({
    props: args,
    template: `<div style="max-width: var(--task-pane-w)"><tc-changes-table [rows]="rows" /></div>`,
  }),
  args: { rows: ROWS },
};

export default meta;
type Story = StoryObj<Args>;

/** The review before a save: Setting · Was · Now in words, the old value struck through and labelled. */
export const Review: Story = {};
/** Long values and paths wrap inside the 375 px phone column. */
export const LongValues: Story = {
  args: {
    rows: [
      {
        path: 'gates.code_paths',
        label: 'Пути кода',
        from: 'apps/**, libs/**, tools/**',
        to: 'apps/**, libs/**, tools/**, packages/very-long-workspace-name/**/src/**',
      },
    ],
  },
};
/** Markup in a value is text, never HTML (threat model T4). */
export const MarkupAsText: Story = {
  args: { rows: [{ path: 'gates.code_paths', label: 'Пути кода', from: 'apps/**', to: '<img src=x onerror=alert(1)>' }] },
};
