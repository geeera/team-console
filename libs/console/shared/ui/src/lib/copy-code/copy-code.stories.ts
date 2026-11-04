import { TranslocoPipe } from '@console/shared/i18n';
import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport, reducedMotion } from '../../../.storybook/stories';
import { CopyCode } from './copy-code';

const meta: Meta<CopyCode> = {
  title: 'Kit/CopyCode',
  component: CopyCode,
  decorators: [moduleMetadata({ imports: [CopyCode, TranslocoPipe] })],
  args: { code: 'setup --env production --check' },
  render: (args) => ({
    props: args,
    template: `
      <div style="max-width: var(--dialog-max-w)">
        <tc-copy-code
          [code]="code"
          [copyLabel]="'settings.common.copy' | transloco"
          [copiedLabel]="'settings.common.copied' | transloco"
          [failedNote]="'settings.common.copyFailed' | transloco"
        />
      </div>
    `,
  }),
};

export default meta;
type Story = StoryObj<CopyCode>;

export const Playground: Story = {};
/** A long command wraps anywhere instead of being cut. */
export const LongCode: Story = {
  args: { code: 'npx wrangler secret put SLOT_ROUTINE_TEAM_CONSOLE_DEVELOPMENT --env production' },
};
export const Dark: Story = { ...darkTheme };
export const ReducedMotion: Story = { ...reducedMotion };
export const Phone: Story = { ...phoneViewport, args: LongCode.args ?? {} };
