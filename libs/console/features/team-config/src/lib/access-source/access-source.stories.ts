import { provideRouter } from '@angular/router';
import type { AccessSource as Source } from '@shared/contracts';
import { applicationConfig, moduleMetadata, type Meta, type StoryObj } from '@storybook/angular';
import { AccessSource } from './access-source';

interface Args {
  readonly source: Source;
  readonly blocked: boolean;
  readonly readOnly: boolean;
  readonly error: string | null;
}

const meta: Meta<Args> = {
  title: 'Features/Team config/Access source',
  decorators: [
    applicationConfig({ providers: [provideRouter([])] }),
    moduleMetadata({ imports: [AccessSource] }),
  ],
  render: (args) => ({
    props: args,
    template: `
      <div style="max-width: var(--task-pane-w)">
        <tc-access-source [source]="source" [blocked]="blocked" [readOnly]="readOnly" [error]="error" />
      </div>
    `,
  }),
  args: { source: 'api_key', blocked: false, readOnly: false, error: null },
};

export default meta;
type Story = StoryObj<Args>;

/** API key chosen; the risk warning is printed under the subscription all the same. */
export const ApiKey: Story = {};
/** A Claude subscription chosen (after its confirmation). */
export const Subscription: Story = { args: { source: 'subscription' } };
/** A hosted runner can reach the project: the subscription is off with its reason and the link to Runners. */
export const HostedRunner: Story = { args: { blocked: true } };
/** A forced save refused with `access-source-hosted`, inline. */
export const RefusedSave: Story = {
  args: { source: 'subscription', error: 'Подписку нельзя выбрать, пока доступен облачный раннер.' },
};
