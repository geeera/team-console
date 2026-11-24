import { SprintCiChip } from '@console/entities/sprint';
import { TranslocoPipe } from '@console/shared/i18n';
import { moduleMetadata, type Meta, type StoryObj } from '@storybook/angular';

// The kit Storybook's toolbar globals (`.storybook/stories.ts`); repeated here rather than imported across projects.
const dark = { globals: { theme: 'dark' } };
const reduced = { globals: { motion: 'reduce' } };

const meta: Meta<SprintCiChip> = {
  title: 'Widgets/Sprint CI chip',
  component: SprintCiChip,
  decorators: [moduleMetadata({ imports: [SprintCiChip, TranslocoPipe] })],
  args: { state: 'pending' },
  argTypes: { state: { control: 'select', options: ['success', 'failure', 'pending', 'none', 'unknown'] } },
};

export default meta;
type Story = StoryObj<SprintCiChip>;

/** Every state at rest. */
export const States: Story = {
  render: () => ({
    template: `
      <div style="display: flex; flex-wrap: wrap; gap: var(--space-2)">
        <tc-sprint-ci-chip state="success" />
        <tc-sprint-ci-chip state="failure" />
        <tc-sprint-ci-chip state="pending" />
        <tc-sprint-ci-chip state="none" />
        <tc-sprint-ci-chip state="unknown" />
      </div>
    `,
  }),
};

/** Press the button while it runs: the dot fills green from its centre and the chip is lit for a moment. */
export const Passes: Story = {
  render: () => ({
    props: { state: 'pending' },
    template: `
      <div style="display: flex; gap: var(--space-3); align-items: center">
        <tc-sprint-ci-chip [state]="state" />
        <button type="button" (click)="state = state === 'pending' ? 'success' : 'pending'">{{ 'stories.ciChip.toggle' | transloco }}</button>
      </div>
    `,
  }),
};

export const Dark: Story = { ...States, ...dark };
/** Reduced motion: the colour changes at once, with no fill and no halo. */
export const ReducedMotion: Story = { ...Passes, ...reduced };
