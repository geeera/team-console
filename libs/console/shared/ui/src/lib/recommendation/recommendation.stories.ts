import { TranslocoPipe } from '@console/shared/i18n';
import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport, reducedMotion } from '../../../.storybook/stories';
import { Button } from '../button/button';
import { Card } from '../card/card';
import { Recommendation } from './recommendation';

const onCard = `
  <tc-card flush tabindex="0" aria-labelledby="rec-card-title">
    <span tc-card-kind>{{ 'stories.card.kind' | transloco }}</span>
    <span tc-card-number>#72</span>
    <h3 tc-card-title id="rec-card-title">{{ 'stories.recommendation.cardTitle' | transloco }}</h3>
    <tc-recommendation [label]="'stories.recommendation.label' | transloco">{{ 'stories.recommendation.choice' | transloco }}</tc-recommendation>
    <button tc-button tc-card-action variant="primary" type="button">{{ 'stories.button.approve' | transloco }}</button>
    <button tc-button tc-card-action type="button">{{ 'stories.button.reject' | transloco }}</button>
  </tc-card>
`;

const meta: Meta<Recommendation> = {
  title: 'Kit/Recommendation',
  component: Recommendation,
  decorators: [moduleMetadata({ imports: [Recommendation, Card, Button, TranslocoPipe] })],
  render: () => ({
    template: `<tc-recommendation [label]="'stories.recommendation.label' | transloco">{{ 'stories.recommendation.choice' | transloco }}</tc-recommendation>`,
  }),
};

export default meta;
type Story = StoryObj<Recommendation>;

export const Default: Story = {};
export const LongText: Story = {
  render: () => ({
    template: `<tc-recommendation [label]="'stories.recommendation.label' | transloco">{{ 'stories.recommendation.long' | transloco }}</tc-recommendation>`,
  }),
};
export const OnACard: Story = { render: () => ({ template: onCard }) };
export const Dark: Story = { ...darkTheme, render: () => ({ template: onCard }) };
export const ReducedMotion: Story = { ...reducedMotion, render: () => ({ template: onCard }) };
export const Phone: Story = { ...phoneViewport, render: () => ({ template: onCard }) };
