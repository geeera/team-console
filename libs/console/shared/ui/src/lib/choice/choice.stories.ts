import { TranslocoPipe } from '@console/shared/i18n';
import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport } from '../../../.storybook/stories';
import { Chip } from '../chip/chip';
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

/** #107: an option unavailable with its reason — focusable, read with the reason, never checked, readable (AA). */
const offWithReason = `
  <fieldset tc-choice-group style="max-width: var(--dialog-max-w)" [legend]="'stories.choice.sprint' | transloco">
    <label tc-choice off>
      <input type="radio" name="sprint" value="current" aria-describedby="story-current-why" />
      <span>{{ 'stories.choice.current' | transloco }} <tc-chip>{{ 'stories.choice.frozen' | transloco }}</tc-chip></span>
      <small tc-choice-hint id="story-current-why">{{ 'stories.choice.currentOff' | transloco }}</small>
    </label>
    <label tc-choice>
      <input type="radio" name="sprint" value="next" checked aria-describedby="story-next-hint" />
      {{ 'stories.choice.next' | transloco }}
      <small tc-choice-hint id="story-next-hint">{{ 'stories.choice.nextHint' | transloco }}</small>
    </label>
    <label tc-choice>
      <input type="radio" name="sprint" value="backlog" aria-describedby="story-backlog-hint" />
      {{ 'stories.choice.backlog' | transloco }}
      <small tc-choice-hint id="story-backlog-hint">{{ 'stories.choice.backlogHint' | transloco }}</small>
    </label>
  </fieldset>
`;
const withChip = moduleMetadata({ imports: [Chip] });
export const OffWithReason: Story = { decorators: [withChip], render: () => ({ template: offWithReason }) };
export const OffWithReasonDark: Story = {
  ...darkTheme,
  decorators: [withChip],
  render: () => ({ template: offWithReason }),
};
