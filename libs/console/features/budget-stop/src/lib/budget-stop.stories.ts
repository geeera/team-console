import { provideHttpClient } from '@angular/common/http';
import type { QuestionBudgetStop } from '@console/entities/question';
import { applicationConfig, moduleMetadata, type Meta, type StoryObj } from '@storybook/angular';
import { BudgetStop } from './budget-stop';

interface Args {
  readonly stop: QuestionBudgetStop;
  readonly canManage: boolean;
}

const STOP: QuestionBudgetStop = {
  project: { slug: 'acme', name: 'Acme' },
  month: '2026-11',
  spentUsd: 201.5,
  budgetUsd: 200,
  stoppedAt: '2026-11-16T10:00:00.000Z',
  paused: false,
};

const meta: Meta<Args> = {
  title: 'Features/Budget stop',
  // The actions call the api; in Storybook they open their dialogs and fail at the request, which shows the error state.
  decorators: [
    applicationConfig({ providers: [provideHttpClient()] }),
    moduleMetadata({ imports: [BudgetStop] }),
  ],
  render: (args) => ({
    props: args,
    template: `
      <div style="max-width: calc(var(--card-min-w) * 2)">
        <tc-budget-stop [stop]="stop" [canManage]="canManage" />
      </div>
    `,
  }),
  args: { stop: STOP, canManage: true },
};

export default meta;
type Story = StoryObj<Args>;

/** The Needs-you row after the finishes that crossed the cap (#684): spend a little past the budget. */
export const PastTheBudget: Story = {};
/** A budget lowered to exactly the month's spend stops the team at once. */
export const AtTheBudget: Story = {
  args: { stop: { ...STOP, spentUsd: 120, budgetUsd: 120 } },
};
/** A long project name wraps; the two actions wrap under each other on the phone. */
export const LongName: Story = {
  args: {
    stop: { ...STOP, project: { slug: 'long', name: 'Платформа внутренних инструментов для отдела продаж' } },
  },
};
/** An owner's own pause also holds (#739): `stoppedAt` is `null`, Raise will not word it away as a restart. */
export const BesideAnOwnerPause: Story = {
  args: { stop: { ...STOP, stoppedAt: null, paused: true } },
};
/** A project member (#735): the figures only, no `Resume this month` or `Raise budget`. */
export const MemberReadOnly: Story = {
  args: { canManage: false },
};
