import { Component, computed, input, signal } from '@angular/core';
import { TranslocoPipe } from '@console/shared/i18n';
import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport, reducedMotion } from '../../../.storybook/stories';
import { Segment, SegmentedRadio } from './segmented';

/** #107's kind picker: three inked segments, the hint under them follows the chosen value. */
@Component({
  selector: 'tc-story-segmented',
  imports: [Segment, SegmentedRadio, TranslocoPipe],
  template: `
    <fieldset
      tc-segmented
      style="max-width: var(--dialog-max-w)"
      [legend]="'stories.segmented.kind' | transloco"
      [stackOnPhone]="stackOnPhone()"
    >
      @for (kind of kinds; track kind) {
        <label tc-segment>
          <input
            type="radio"
            name="story-kind"
            aria-describedby="story-kind-hint"
            [value]="kind"
            [checked]="kind === chosen()"
            (change)="chosen.set(kind)"
          />
          {{ 'stories.segmented.' + kind | transloco }}
        </label>
      }
      <p tc-segmented-hint id="story-kind-hint">{{ hintKey() | transloco }}</p>
    </fieldset>
  `,
})
class SegmentedStory {
  readonly stackOnPhone = input(false);
  protected readonly kinds = ['feature', 'bug', 'chore'] as const;
  protected readonly chosen = signal<(typeof this.kinds)[number]>('feature');
  protected readonly hintKey = computed(() => `stories.segmented.${this.chosen()}Hint`);
}

/** A segment that cannot be chosen yet (e.g. a kind the current plan tier does not allow). */
@Component({
  selector: 'tc-story-segmented-disabled',
  imports: [Segment, SegmentedRadio, TranslocoPipe],
  template: `
    <fieldset tc-segmented style="max-width: var(--dialog-max-w)" [legend]="'stories.segmented.kind' | transloco">
      <label tc-segment>
        <input type="radio" name="story-kind-disabled" value="feature" checked />
        {{ 'stories.segmented.feature' | transloco }}
      </label>
      <label tc-segment>
        <input type="radio" name="story-kind-disabled" value="bug" disabled />
        {{ 'stories.segmented.bug' | transloco }}
      </label>
      <label tc-segment>
        <input type="radio" name="story-kind-disabled" value="chore" disabled />
        {{ 'stories.segmented.chore' | transloco }}
      </label>
    </fieldset>
  `,
})
class SegmentedDisabledStory {}

const meta: Meta<SegmentedRadio> = {
  title: 'Kit/SegmentedRadio',
  component: SegmentedRadio,
  decorators: [moduleMetadata({ imports: [SegmentedStory, SegmentedDisabledStory] })],
  render: () => ({ template: '<tc-story-segmented />' }),
};

export default meta;
type Story = StoryObj<SegmentedRadio>;

export const Kind: Story = {};
export const Dark: Story = { ...darkTheme };
export const ReducedMotion: Story = { ...reducedMotion };
export const Phone: Story = { ...phoneViewport };
/** #688: on the phone the segments stack into one column instead of truncating their words. */
export const StackedOnPhone: Story = {
  ...phoneViewport,
  render: () => ({ template: '<tc-story-segmented [stackOnPhone]="true" />' }),
};
export const Disabled: Story = { render: () => ({ template: '<tc-story-segmented-disabled />' }) };
