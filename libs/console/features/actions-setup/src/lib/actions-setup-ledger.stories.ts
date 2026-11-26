import { actionsSetupFixture } from '@console/entities/actions-setup';
import type { ActionsFirstJob } from '@console/entities/job';
import type { ActionsSetupDto } from '@shared/contracts';
import { applicationConfig, moduleMetadata, type Meta, type StoryObj } from '@storybook/angular';
import { ActionsSetupLedger } from './actions-setup-ledger';
import { actionsStoryProviders, STORY_PR_URL as PR_URL } from './actions-setup.story-kit';

interface Args {
  readonly setup: ActionsSetupDto | null;
  readonly firstJob: ActionsFirstJob | null;
}

const meta: Meta<Args> = {
  title: 'Features/Actions setup/Ledger',
  decorators: [
    applicationConfig({
      providers: actionsStoryProviders(),
    }),
    moduleMetadata({ imports: [ActionsSetupLedger] }),
  ],
  render: (args) => ({
    props: args,
    template: `
      <div style="max-width: var(--cards-max)">
        <tc-actions-setup-ledger
          slug="storify"
          repo="geeera/storify"
          projectName="storify"
          branch="main"
          branchLabel="main"
          teamUrl="/settings/projects/storify/team"
          [setup]="setup"
          [firstJob]="firstJob"
        />
      </div>
    `,
  }),
  args: {
    firstJob: null,
    setup: actionsSetupFixture({ items: { secret: { status: 'missing' }, workflow: { status: 'missing' } } }),
  },
};

export default meta;
type Story = StoryObj<Args>;

/** Two steps missing: the environment's key and the workflow file; step 3 is open. */
export const Partial: Story = {};
/** Before the first answer: titles only. */
export const Loading: Story = { args: { setup: null } };
/** The app's new permissions are not accepted: the secret reads «не проверено», the Copy path leads. */
export const PermissionsNotAccepted: Story = {
  args: {
    setup: actionsSetupFixture({
      items: {
        'app-permissions': { status: 'missing', link: 'https://github.com/settings/installations/1' },
        secret: { status: 'unknown' },
        workflow: { status: 'missing' },
      },
    }),
  },
};
/** The console's PR is open. */
export const PrOpen: Story = {
  args: {
    setup: actionsSetupFixture({
      items: { workflow: { status: 'missing', pr: { number: 42, url: PR_URL, provenance: 'console' } } },
    }),
  },
};
/** A PR on the console's branch it cannot vouch for: never "merge it". */
export const PrForeign: Story = {
  args: {
    setup: actionsSetupFixture({
      items: { workflow: { status: 'missing', pr: { number: 43, url: PR_URL, provenance: 'foreign' } } },
    }),
  },
};
/** Reviewers on the Environment: a warning, the step stays done. */
export const ReviewersWarning: Story = {
  args: { setup: actionsSetupFixture({ items: { 'protection-rules': { status: 'wrong' } } }) },
};
/** Everything is ready; «Включить» is the primary action. */
export const Ready: Story = { args: { setup: actionsSetupFixture() } };
/** Switched on. */
export const On: Story = { args: { setup: actionsSetupFixture({ dispatch: 'actions' }) } };
/** Switched on, no job yet: step 6 waits and points to the project. */
export const FirstJobWaiting: Story = {
  args: { setup: actionsSetupFixture({ dispatch: 'actions' }), firstJob: { kind: 'waiting' } },
};
/** The first job passed. */
export const FirstJobDone: Story = {
  args: {
    setup: actionsSetupFixture({ dispatch: 'actions' }),
    firstJob: { kind: 'done', at: '2026-11-21T12:10:00.000Z' },
  },
};
/** The first job never reached GitHub's runner: the reason is in words. */
export const FirstJobFailed: Story = {
  args: {
    setup: actionsSetupFixture({ dispatch: 'actions' }),
    firstJob: { kind: 'failed', reason: 'actions-no-show' },
  },
};
