import { TranslocoPipe } from '@console/shared/i18n';
import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport, reducedMotion } from '../../../.storybook/stories';
import { Receipt } from './receipt';

const receipt = (tone: string, verb: string) => `
  <tc-receipt tone="${tone}">
    <span tc-receipt-verb>{{ 'stories.receipt.${verb}' | transloco }}</span>
    <span tc-receipt-detail>{{ 'stories.receipt.detail' | transloco }}</span>
    <span tc-receipt-meta>{{ 'stories.receipt.meta' | transloco }}</span>
  </tc-receipt>
`;

const allTones = `
  <div style="display: grid; gap: var(--space-4)">
    ${receipt('positive', 'approved')}
    ${receipt('negative', 'rejected')}
    ${receipt('neutral', 'done')}
  </div>
`;

const meta: Meta<Receipt> = {
  title: 'Kit/Receipt',
  component: Receipt,
  decorators: [moduleMetadata({ imports: [Receipt, TranslocoPipe] })],
  argTypes: { tone: { control: 'select', options: ['positive', 'negative', 'neutral'] } },
  args: { tone: 'positive' },
  render: (args) => ({
    props: args,
    template: `
      <tc-receipt [tone]="tone">
        <span tc-receipt-verb>{{ 'stories.receipt.approved' | transloco }}</span>
        <span tc-receipt-detail>{{ 'stories.receipt.detail' | transloco }}</span>
        <span tc-receipt-meta>{{ 'stories.receipt.meta' | transloco }}</span>
      </tc-receipt>
    `,
  }),
};

export default meta;
type Story = StoryObj<Receipt>;

export const Playground: Story = {};
export const Tones: Story = { render: () => ({ template: allTones }) };
export const Dark: Story = { ...darkTheme, render: () => ({ template: allTones }) };
export const ReducedMotion: Story = { ...reducedMotion, render: () => ({ template: allTones }) };
export const Phone: Story = { ...phoneViewport, render: () => ({ template: allTones }) };
