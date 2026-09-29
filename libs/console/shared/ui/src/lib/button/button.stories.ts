import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport, reducedMotion } from '../../../.storybook/stories';
import { Icon } from '../icon/icon';
import { Button, IconButton } from './button';

const allVariants = `
  <div style="display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center">
    <button tc-button variant="primary" type="button">Утвердить</button>
    <button tc-button variant="secondary" type="button">Отклонить</button>
    <button tc-button variant="quiet" type="button">Позже</button>
    <button tc-button variant="danger" type="button">В архив</button>
    <button tc-button variant="primary" size="sm" type="button">Маленькая</button>
    <button tc-button variant="primary" type="button" disabled>Недоступна</button>
    <button tc-button variant="primary" type="button" loading>Сохраняем…</button>
    <button tc-icon-button type="button" aria-label="Закрыть"><tc-icon name="x" size="lg" /></button>
  </div>
`;

const meta: Meta<Button> = {
  title: 'Kit/Button',
  component: Button,
  decorators: [moduleMetadata({ imports: [Button, IconButton, Icon] })],
  argTypes: {
    variant: { control: 'select', options: ['primary', 'secondary', 'quiet', 'danger'] },
    size: { control: 'select', options: ['sm', 'md'] },
  },
  args: { variant: 'primary', size: 'md', block: false, loading: false },
  render: (args) => ({
    props: args,
    template: `<button tc-button [variant]="variant" [size]="size" [block]="block" [loading]="loading" type="button">Утвердить</button>`,
  }),
};

export default meta;
type Story = StoryObj<Button>;

export const Playground: Story = {};

export const Variants: Story = { render: () => ({ template: allVariants }) };

export const Dark: Story = { ...darkTheme, render: () => ({ template: allVariants }) };

export const ReducedMotion: Story = { ...reducedMotion, render: () => ({ template: allVariants }) };

export const Phone: Story = {
  ...phoneViewport,
  render: () => ({
    template: `
      <div style="display: grid; gap: var(--space-2)">
        <button tc-button variant="primary" block type="button">Утвердить · закрыть</button>
        <button tc-button variant="secondary" block type="button">Отклонить</button>
      </div>
    `,
  }),
};
