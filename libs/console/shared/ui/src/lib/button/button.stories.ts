import { TranslocoPipe } from '@console/shared/i18n';
import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport, reducedMotion } from '../../../.storybook/stories';
import { Icon } from '../icon/icon';
import { Button, IconButton } from './button';

const allVariants = `
  <div style="display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center">
    <button tc-button variant="primary" type="button">{{ 'stories.button.approve' | transloco }}</button>
    <button tc-button variant="secondary" type="button">{{ 'stories.button.reject' | transloco }}</button>
    <button tc-button variant="quiet" type="button">{{ 'stories.button.later' | transloco }}</button>
    <button tc-button variant="danger" type="button">{{ 'stories.button.archive' | transloco }}</button>
    <button tc-button variant="primary" size="sm" type="button">{{ 'stories.button.small' | transloco }}</button>
    <button tc-button variant="primary" type="button" disabled>{{ 'stories.button.disabled' | transloco }}</button>
    <button tc-button variant="primary" type="button" loading>{{ 'stories.button.saving' | transloco }}</button>
    <button tc-icon-button type="button" [attr.aria-label]="'ui.close' | transloco"><tc-icon name="x" size="lg" /></button>
  </div>
`;

const meta: Meta<Button> = {
  title: 'Kit/Button',
  component: Button,
  decorators: [moduleMetadata({ imports: [Button, IconButton, Icon, TranslocoPipe] })],
  argTypes: {
    variant: { control: 'select', options: ['primary', 'secondary', 'quiet', 'danger'] },
    size: { control: 'select', options: ['sm', 'md'] },
  },
  args: { variant: 'primary', size: 'md', block: false, loading: false },
  render: (args) => ({
    props: args,
    template: `<button tc-button [variant]="variant" [size]="size" [block]="block" [loading]="loading" type="button">{{ 'stories.button.approve' | transloco }}</button>`,
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
        <button tc-button variant="primary" block type="button">{{ 'stories.button.approveClose' | transloco }}</button>
        <button tc-button variant="secondary" block type="button">{{ 'stories.button.reject' | transloco }}</button>
      </div>
    `,
  }),
};
