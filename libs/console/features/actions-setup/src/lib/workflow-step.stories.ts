import { actionsSetupFixture } from '@console/entities/actions-setup';
import type { ActionsSetupDto } from '@shared/contracts';
import { applicationConfig, moduleMetadata, type Meta, type StoryObj } from '@storybook/angular';
import { actionsStoryProviders, STORY_PR_URL } from './actions-setup.story-kit';
import { WorkflowStep } from './workflow-step';

interface Args {
  readonly setup: ActionsSetupDto;
}

const BLOB_URL = 'https://github.com/geeera/storify/blob/main/.github/workflows/team-console-runner.yml';

const meta: Meta<Args> = {
  title: 'Features/Actions setup/Workflow step',
  decorators: [applicationConfig({ providers: actionsStoryProviders() }), moduleMetadata({ imports: [WorkflowStep] })],
  render: (args) => ({
    props: args,
    template: `
      <div style="max-width: var(--cards-max)">
        <tc-workflow-step slug="storify" repo="geeera/storify" branch="main" branchLabel="main" [setup]="setup" />
      </div>
    `,
  }),
  args: { setup: actionsSetupFixture({ items: { workflow: { status: 'missing' } } }) },
};

export default meta;
type Story = StoryObj<Args>;

/** No file on the default branch: «Открыть PR» leads, «Показать файл» is beside it. */
export const Missing: Story = {};
/** The file is current. */
export const Ok: Story = { args: { setup: actionsSetupFixture() } };
/** A newer template exists: the PR updates the file. */
export const Outdated: Story = { args: { setup: actionsSetupFixture({ items: { workflow: { status: 'outdated' } } }) } };
/** Someone edited the file: the PR restores it, the blob is linked. */
export const Modified: Story = {
  args: { setup: actionsSetupFixture({ items: { workflow: { status: 'modified', link: BLOB_URL } } }) },
};
/** The console's PR is open. */
export const PrOpen: Story = {
  args: { setup: actionsSetupFixture({ items: { workflow: { status: 'missing', pr: { number: 42, url: STORY_PR_URL, provenance: 'console' } } } }) },
};
/** A PR on the console's branch it cannot vouch for: never called mergeable. */
export const PrForeign: Story = {
  args: { setup: actionsSetupFixture({ items: { workflow: { status: 'missing', pr: { number: 43, url: STORY_PR_URL, provenance: 'foreign' } } } }) },
};
/** The file is in place but an old console PR is still open. */
export const Leftover: Story = {
  args: { setup: actionsSetupFixture({ items: { workflow: { status: 'ok', pr: { number: 41, url: STORY_PR_URL, provenance: 'console' } } } }) },
};
/** The file could not be read: no action is guessed. */
export const Unknown: Story = { args: { setup: actionsSetupFixture({ items: { workflow: { status: 'unknown' } } }) } };
/** The app lacks the PR permissions: the Copy path leads and says why. */
export const CopyPath: Story = {
  args: {
    setup: actionsSetupFixture({
      items: { 'app-permissions': { status: 'missing', link: 'https://github.com/settings/installations/1' }, workflow: { status: 'missing' } },
    }),
  },
};
