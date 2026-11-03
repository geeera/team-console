import { TranslocoPipe } from '@console/shared/i18n';
import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport, reducedMotion } from '../../../.storybook/stories';
import { Button } from '../button/button';
import { Card } from '../card/card';
import { Receipt } from '../receipt/receipt';

/** The class `markArrival()` adds; the story shows the ring as it stays after the swell. */
const arrived = `
  <div style="display: grid; gap: var(--space-6); max-width: var(--log-max); padding: var(--space-4)">
    <tc-card flush class="tc-arrival">
      <span tc-card-kind>{{ 'stories.arrival.kind' | transloco }}</span>
      <span tc-card-number>#42</span>
      <h2 tc-card-title tabindex="-1">{{ 'stories.arrival.title' | transloco }}</h2>
      <p>{{ 'stories.arrival.body' | transloco }}</p>
      <button tc-button tc-card-action variant="primary" type="button">{{ 'stories.arrival.action' | transloco }}</button>
    </tc-card>
    <tc-receipt class="tc-arrival">
      <span tc-receipt-verb>{{ 'stories.arrival.receiptVerb' | transloco }}</span>
      <span tc-receipt-detail>{{ 'stories.arrival.title' | transloco }}</span>
      <span tc-receipt-meta>#45 · 14:02</span>
    </tc-receipt>
  </div>
`;

const meta: Meta = {
  title: 'Kit/Arrival',
  decorators: [moduleMetadata({ imports: [Button, Card, Receipt, TranslocoPipe] })],
  render: () => ({ template: arrived }),
};

export default meta;
type Story = StoryObj;

export const Ringed: Story = {};
export const Dark: Story = { ...darkTheme };
export const ReducedMotion: Story = { ...reducedMotion };
export const Phone: Story = { ...phoneViewport };
