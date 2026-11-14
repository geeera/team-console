import { Component, computed, signal } from '@angular/core';
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
  protected readonly kinds = ['feature', 'bug', 'chore'] as const;
  protected readonly chosen = signal<(typeof this.kinds)[number]>('feature');
  protected readonly hintKey = computed(() => `stories.segmented.${this.chosen()}Hint`);
}

const meta: Meta<SegmentedRadio> = {
  title: 'Kit/SegmentedRadio',
  component: SegmentedRadio,
  decorators: [moduleMetadata({ imports: [SegmentedStory] })],
  render: () => ({ template: '<tc-story-segmented />' }),
};

export default meta;
type Story = StoryObj<SegmentedRadio>;

export const Kind: Story = {};
export const Dark: Story = { ...darkTheme };
export const ReducedMotion: Story = { ...reducedMotion };
export const Phone: Story = { ...phoneViewport };
