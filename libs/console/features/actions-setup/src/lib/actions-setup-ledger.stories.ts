import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { ActionsSetupApi, actionsSetupFixture } from '@console/entities/actions-setup';
import { RunnersApi } from '@console/entities/runner';
import { NetworkStatus } from '@console/shared/api';
import type { ActionsSetupDto } from '@shared/contracts';
import { applicationConfig, moduleMetadata, type Meta, type StoryObj } from '@storybook/angular';
import { ActionsSetupLedger } from './actions-setup-ledger';

interface Args {
  readonly setup: ActionsSetupDto | null;
}

const PR_URL = 'https://github.com/geeera/storify/pull/42';
const WORKFLOW = { text: 'name: Team Console runner\non:\n  workflow_dispatch:\n', sha256: 'a'.repeat(64), version: '0.42.0' };

const meta: Meta<Args> = {
  title: 'Features/Actions setup/Ledger',
  decorators: [
    applicationConfig({
      providers: [
        provideRouter([]),
        { provide: NetworkStatus, useValue: { online: signal(true) } },
        {
          provide: ActionsSetupApi,
          useValue: {
            workflow: async () => ({ ok: true, value: WORKFLOW }),
            openWorkflowPr: async () => ({ ok: true, value: { number: 42, url: PR_URL, kind: 'setup' } }),
          },
        },
        { provide: RunnersApi, useValue: { setDispatch: async () => ({ ok: true, value: { dispatch: 'actions', defaultBranch: 'main' } }) } },
      ],
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
        />
      </div>
    `,
  }),
  args: { setup: actionsSetupFixture({ items: { secret: { status: 'missing' }, workflow: { status: 'missing' } } }) },
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
  args: { setup: actionsSetupFixture({ items: { workflow: { status: 'missing', pr: { number: 42, url: PR_URL, provenance: 'console' } } } }) },
};
/** A PR on the console's branch it cannot vouch for: never "merge it". */
export const PrForeign: Story = {
  args: { setup: actionsSetupFixture({ items: { workflow: { status: 'missing', pr: { number: 43, url: PR_URL, provenance: 'foreign' } } } }) },
};
/** Reviewers on the Environment: a warning, the step stays done. */
export const ReviewersWarning: Story = { args: { setup: actionsSetupFixture({ items: { 'protection-rules': { status: 'wrong' } } }) } };
/** Everything is ready; «Включить» is the primary action. */
export const Ready: Story = { args: { setup: actionsSetupFixture() } };
/** Switched on. */
export const On: Story = { args: { setup: actionsSetupFixture({ dispatch: 'actions' }) } };
