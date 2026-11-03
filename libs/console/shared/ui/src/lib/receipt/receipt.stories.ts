import { TranslocoPipe } from '@console/shared/i18n';
import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport, reducedMotion } from '../../../.storybook/stories';
import { Chip } from '../chip/chip';
import { Icon } from '../icon/icon';
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
    ${receipt('warning', 'unknown')}
  </div>
`;

const meta: Meta<Receipt> = {
  title: 'Kit/Receipt',
  component: Receipt,
  decorators: [moduleMetadata({ imports: [Chip, Icon, Receipt, TranslocoPipe] })],
  argTypes: { tone: { control: 'select', options: ['positive', 'negative', 'neutral', 'warning'] } },
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
/** An answered question (#328): the status as a chip with an icon, flush in its grid cell. */
export const WithStatusChip: Story = {
  render: () => ({
    template: `
      <tc-receipt flush [hasGlyph]="false">
        <tc-chip tc-receipt-verb tone="success"><tc-icon name="check" size="sm" />{{ 'stories.receipt.approved' | transloco }}</tc-chip>
        <span tc-receipt-detail>{{ 'stories.receipt.detail' | transloco }}</span>
        <span tc-receipt-meta>{{ 'stories.receipt.meta' | transloco }}</span>
      </tc-receipt>
    `,
  }),
};
export const Dark: Story = { ...darkTheme, render: () => ({ template: allTones }) };
export const ReducedMotion: Story = { ...reducedMotion, render: () => ({ template: allTones }) };
export const Phone: Story = { ...phoneViewport, render: () => ({ template: allTones }) };
