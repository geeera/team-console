import { applicationConfig, moduleMetadata, type Meta, type StoryObj } from '@storybook/angular';
import { actionsStoryProviders } from './actions-setup.story-kit';
import { WorkflowFile } from './workflow-file';

interface Args {
  readonly branch: string | null;
}

const meta: Meta<Args> = {
  title: 'Features/Actions setup/Workflow file',
  decorators: [applicationConfig({ providers: actionsStoryProviders() }), moduleMetadata({ imports: [WorkflowFile] })],
  render: (args) => ({
    props: args,
    template: `
      <div style="max-width: var(--cards-max)">
        <tc-workflow-file slug="storify" repo="geeera/storify" branchLabel="main" [branch]="branch" />
      </div>
    `,
  }),
  args: { branch: 'main' },
};

export default meta;
type Story = StoryObj<Args>;

/** The console's rendering with its version and sha256, Copy, and the link to create it on GitHub. */
export const Ready: Story = {};
/** The default branch was never read: no «Создать файл» link, the note says «по умолчанию». */
export const UnknownBranch: Story = { args: { branch: null } };

/** The read is still on its way. */
export const Loading: Story = {
  decorators: [applicationConfig({ providers: actionsStoryProviders({ workflow: () => new Promise(() => undefined) }) })],
};
/** GitHub or the console failed: an error block with Retry. */
export const LoadFailed: Story = {
  decorators: [
    applicationConfig({ providers: actionsStoryProviders({ workflow: async () => ({ ok: false, problem: { kind: 'failed' } }) }) }),
  ],
};
/** The console cannot build the file (503): the repository is fine, no Retry. */
export const Misconfigured: Story = {
  decorators: [
    applicationConfig({
      providers: actionsStoryProviders({ workflow: async () => ({ ok: false, problem: { kind: 'misconfigured' } }) }),
    }),
  ],
};
