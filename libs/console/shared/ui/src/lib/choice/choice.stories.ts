import { TranslocoPipe } from '@console/shared/i18n';
import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport } from '../../../.storybook/stories';
import { Choice, ChoiceGroup } from './choice';

const options = ['hour', 'morning', 'week', 'forever'];

const both = (disabled: boolean) => `
  <div style="display: grid; gap: var(--space-4); max-width: var(--dialog-max-w)">
    <fieldset tc-choice-group [legend]="'stories.choice.when' | transloco">
      ${options
        .map(
          (value, index) => `
        <label tc-choice>
          <input type="radio" name="when" value="${value}"${index === 1 ? ' checked' : ''}${disabled ? ' disabled' : ''} />
          {{ 'stories.choice.${value}' | transloco }}
        </label>`,
        )
        .join('')}
    </fieldset>
    <label tc-choice>
      <input type="checkbox" checked aria-describedby="story-urgent-hint"${disabled ? ' disabled' : ''} />
      {{ 'stories.choice.urgent' | transloco }}
      <small tc-choice-hint id="story-urgent-hint">{{ 'stories.choice.urgentHint' | transloco }}</small>
    </label>
  </div>
`;

const meta: Meta<ChoiceGroup> = {
  title: 'Kit/Choice',
  component: ChoiceGroup,
  decorators: [moduleMetadata({ imports: [Choice, ChoiceGroup, TranslocoPipe] })],
  render: () => ({ template: both(false) }),
};

export default meta;
type Story = StoryObj<ChoiceGroup>;

export const RadiosAndCheckbox: Story = {};
export const Disabled: Story = { render: () => ({ template: both(true) }) };
export const Dark: Story = { ...darkTheme, render: () => ({ template: both(false) }) };
export const Phone: Story = { ...phoneViewport, render: () => ({ template: both(false) }) };
