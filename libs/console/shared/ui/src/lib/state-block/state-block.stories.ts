import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport, reducedMotion } from '../../../.storybook/stories';
import { Button } from '../button/button';
import { StateBlock } from './state-block';

const allKinds = `
  <div style="display: grid; gap: var(--space-4)">
    <tc-state-block kind="empty" title="Ничего не ждёт" description="Все вопросы команды закрыты. Загляните позже." />
    <tc-state-block kind="error" title="Не удалось загрузить проекты" description="GitHub не ответил. Проверьте связь и попробуйте ещё раз.">
      <button tc-button tc-state-action variant="primary" type="button">Повторить</button>
    </tc-state-block>
    <tc-state-block kind="loading" />
    <tc-state-block kind="empty" compact title="В этой колонке пусто" />
    <tc-state-block kind="loading" compact />
  </div>
`;

const meta: Meta<StateBlock> = {
  title: 'Kit/State block',
  component: StateBlock,
  decorators: [moduleMetadata({ imports: [StateBlock, Button] })],
  argTypes: { kind: { control: 'select', options: ['empty', 'error', 'loading'] } },
  args: { kind: 'empty', title: '', description: '', compact: false },
  render: (args) => ({
    props: args,
    template: `<tc-state-block [kind]="kind" [title]="title" [description]="description" [compact]="compact" />`,
  }),
};

export default meta;
type Story = StoryObj<StateBlock>;

export const Playground: Story = {};
export const Kinds: Story = { render: () => ({ template: allKinds }) };
export const Dark: Story = { ...darkTheme, render: () => ({ template: allKinds }) };
export const ReducedMotion: Story = { ...reducedMotion, render: () => ({ template: allKinds }) };
export const Phone: Story = { ...phoneViewport, render: () => ({ template: allKinds }) };
