import { TranslocoPipe } from '@console/shared/i18n';
import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport, reducedMotion } from '../../../.storybook/stories';
import { Button } from '../button/button';
import { StateBlock } from './state-block';

const allKinds = `
  <div style="display: grid; gap: var(--space-4)">
    <tc-state-block kind="empty" [title]="'stories.stateBlock.emptyTitle' | transloco" [description]="'stories.stateBlock.emptyDescription' | transloco" />
    <tc-state-block kind="error" [title]="'stories.stateBlock.errorTitle' | transloco" [description]="'stories.stateBlock.errorDescription' | transloco">
      <button tc-button tc-state-action variant="primary" type="button">{{ 'ui.error.retry' | transloco }}</button>
    </tc-state-block>
    <tc-state-block kind="loading" />
    <tc-state-block kind="empty" compact [title]="'stories.stateBlock.compactEmptyTitle' | transloco" />
    <tc-state-block kind="empty" compact icon="question" [title]="'stories.stateBlock.unavailableTitle' | transloco" [description]="'stories.stateBlock.unavailableDescription' | transloco" />
    <tc-state-block kind="loading" compact />
  </div>
`;

const meta: Meta<StateBlock> = {
  title: 'Kit/State block',
  component: StateBlock,
  decorators: [moduleMetadata({ imports: [StateBlock, Button, TranslocoPipe] })],
  argTypes: { kind: { control: 'select', options: ['empty', 'error', 'loading'] } },
  args: { kind: 'empty', compact: false },
  render: (args) => ({
    props: args,
    template: `<tc-state-block [kind]="kind" [compact]="compact" />`,
  }),
};

export default meta;
type Story = StoryObj<StateBlock>;

export const Playground: Story = {};
export const Kinds: Story = { render: () => ({ template: allKinds }) };
export const Dark: Story = { ...darkTheme, render: () => ({ template: allKinds }) };
export const ReducedMotion: Story = { ...reducedMotion, render: () => ({ template: allKinds }) };
export const Phone: Story = { ...phoneViewport, render: () => ({ template: allKinds }) };
