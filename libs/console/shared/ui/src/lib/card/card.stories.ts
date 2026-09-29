import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport, reducedMotion } from '../../../.storybook/stories';
import { Button } from '../button/button';
import { Chip } from '../chip/chip';
import { Card } from './card';

const decision = (stamp: string) => `
  <tc-card [stamp]="${stamp}" tabindex="0" aria-labelledby="card-title">
    <span tc-card-kind>Вопрос</span>
    <span tc-card-number>#13</span>
    <h3 tc-card-title id="card-title">Принять дизайн-кит и токены Paper Desk?</h3>
    <p>Токены, примитивы и Storybook готовы. Команда рекомендует утвердить и закрыть задачу.</p>
    <button tc-button tc-card-action variant="primary" type="button">Утвердить · закрыть</button>
    <button tc-button tc-card-action type="button">Отклонить</button>
    <span tc-card-meta>2 часа назад · Team Console</span>
  </tc-card>
`;

const meta: Meta<Card> = {
  title: 'Kit/Card',
  component: Card,
  decorators: [moduleMetadata({ imports: [Card, Button, Chip] })],
  argTypes: { stamp: { control: 'select', options: [null, 'positive', 'negative', 'neutral'] } },
  args: { stamp: null, flush: false },
  render: (args) => ({
    props: args,
    template: `
      <tc-card [stamp]="stamp" [flush]="flush" tabindex="0" aria-labelledby="card-title">
        <span tc-card-kind>Вопрос</span>
        <span tc-card-number>#13</span>
        <h3 tc-card-title id="card-title">Принять дизайн-кит и токены Paper Desk?</h3>
        <p>Токены, примитивы и Storybook готовы. Команда рекомендует утвердить и закрыть задачу.</p>
        <button tc-button tc-card-action variant="primary" type="button">Утвердить · закрыть</button>
        <button tc-button tc-card-action type="button">Отклонить</button>
        <span tc-card-meta>2 часа назад · Team Console</span>
      </tc-card>
    `,
  }),
};

export default meta;
type Story = StoryObj<Card>;

export const Decision: Story = {};

export const Stamped: Story = {
  render: () => ({
    template: `
      <div style="display: grid; gap: var(--space-4)">
        ${decision("'positive'")}
        ${decision("'negative'")}
        ${decision("'neutral'")}
      </div>
    `,
  }),
};

export const Minimal: Story = {
  render: () => ({
    template: `
      <tc-card flush>
        <h3 tc-card-title>Только заголовок и текст</h3>
        <p>Без шапки, действий и подписи блоки прячутся сами.</p>
      </tc-card>
    `,
  }),
};

export const Dark: Story = { ...darkTheme, args: { stamp: 'positive' } };
export const ReducedMotion: Story = { ...reducedMotion, args: { stamp: 'positive' } };
export const Phone: Story = { ...phoneViewport, args: { stamp: null } };
