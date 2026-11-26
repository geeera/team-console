import { actionsSetupFixture } from '@console/entities/actions-setup';
import type { ActionsSetupDto } from '@shared/contracts';
import { applicationConfig, moduleMetadata, type Meta, type StoryObj } from '@storybook/angular';
import { actionsStoryProviders } from './actions-setup.story-kit';
import { ActionsSwitchOn } from './switch-on';

interface Args {
  readonly setup: ActionsSetupDto;
  readonly missing: number;
}

const meta: Meta<Args> = {
  title: 'Features/Actions setup/Switch on',
  decorators: [
    applicationConfig({ providers: actionsStoryProviders() }),
    moduleMetadata({ imports: [ActionsSwitchOn] }),
  ],
  render: (args) => ({
    props: args,
    template: `
      <div style="max-width: var(--cards-max)">
        <tc-actions-switch-on slug="storify" projectName="storify" teamUrl="/settings/projects/storify/team" [setup]="setup" [missing]="missing" />
      </div>
    `,
  }),
  args: { setup: actionsSetupFixture(), missing: 0 },
};

export default meta;
type Story = StoryObj<Args>;

/** Every step is done: «Включить» is the primary action. */
export const Ready: Story = {};
/** Steps are missing: the button is `aria-disabled` and the line under it says how many. */
export const Blocked: Story = {
  args: {
    setup: actionsSetupFixture({ items: { secret: { status: 'missing' }, workflow: { status: 'missing' } } }),
    missing: 2,
  },
};
/** Already on: the state and the way back to Runners. */
export const On: Story = { args: { setup: actionsSetupFixture({ dispatch: 'actions' }) } };
