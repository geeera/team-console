import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe } from '@console/shared/i18n';
import { addDays } from '@shared/contracts';
import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { expect, userEvent, waitFor } from 'storybook/test';
import { darkTheme, phoneViewport, reducedMotion } from '../../../.storybook/stories';
import { Field } from '../field/field';
import { DatePicker, type DatePickerProblem } from './date-picker';
import { localTodayOf, weekdayIndexOf } from './date-math';

/** Offsets from the day the story runs, so «Сегодня», the past and min/max always mean what the story says. */
interface StoryArgs {
  /** The value, in days from today; `null` starts empty. */
  readonly valueIn: number | null;
  readonly minIn: number | null;
  readonly maxIn: number | null;
  /** Weekends cannot be picked (a stand-in for any `isDateDisabled`). */
  readonly noWeekends: boolean;
  readonly disabled: boolean;
  /** Typed into the field and left, as the owner would. */
  readonly typed: string;
  /** Opens the calendar as soon as the story renders. */
  readonly open: boolean;
}

@Component({
  selector: 'tc-story-date-picker',
  imports: [DatePicker, Field, FormsModule, TranslocoPipe],
  template: `
    <div style="display: grid; gap: var(--space-3); max-width: var(--dialog-max-w)">
      <tc-field
        [label]="'stories.datePicker.label' | transloco"
        [hint]="'stories.datePicker.hint' | transloco"
        [error]="problem()?.message ?? ''"
        required
      >
        <tc-date-picker
          [label]="'stories.datePicker.label' | transloco"
          [min]="min()"
          [max]="max()"
          [isDateDisabled]="isDateDisabled()"
          [disabled]="disabled()"
          [ngModel]="value()"
          (ngModelChange)="value.set($event)"
          (problemChange)="problem.set($event)"
        />
      </tc-field>
      <p style="margin: 0; font-size: var(--fs-sm); color: var(--text-2)">
        {{
          'stories.datePicker.selected'
            | transloco: { date: value() ?? ('stories.datePicker.none' | transloco) }
        }}
      </p>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class DatePickerStory {
  readonly valueIn = input<number | null>(null);
  readonly minIn = input<number | null>(null);
  readonly maxIn = input<number | null>(null);
  readonly noWeekends = input(false);
  readonly disabled = input(false);
  readonly typed = input('');
  readonly open = input(false);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly picker = viewChild.required(DatePicker);
  private readonly today = localTodayOf(new Date());

  protected readonly value = signal<string | null>(null);
  protected readonly problem = signal<DatePickerProblem | null>(null);
  protected readonly min = computed(() => this.dayIn(this.minIn()));
  protected readonly max = computed(() => this.dayIn(this.maxIn()));
  protected readonly isDateDisabled = computed(() =>
    this.noWeekends() ? (day: string) => weekdayIndexOf(day) >= 5 : () => false,
  );

  constructor() {
    afterNextRender(() => {
      this.value.set(this.dayIn(this.valueIn()));
      const typed = this.typed();
      if (typed !== '') {
        const field = this.host.nativeElement.querySelector('input') as HTMLInputElement;
        field.value = typed;
        field.dispatchEvent(new Event('input'));
        field.dispatchEvent(new Event('blur'));
      }
      if (this.open()) {
        // After ngModel has written the value, so the calendar opens on it.
        setTimeout(() => this.picker().open());
      }
    });
  }

  private dayIn(offset: number | null): string | null {
    return offset === null ? null : addDays(this.today, offset);
  }
}

const meta: Meta<StoryArgs> = {
  title: 'Kit/DatePicker',
  decorators: [moduleMetadata({ imports: [DatePickerStory] })],
  argTypes: {
    valueIn: { control: 'number' },
    minIn: { control: 'number' },
    maxIn: { control: 'number' },
  },
  args: { valueIn: 8, minIn: null, maxIn: null, noWeekends: false, disabled: false, typed: '', open: false },
  // The calendar renders in the CDK overlay container, outside the story root; axe must see both.
  parameters: { a11y: { context: 'body' } },
  render: (args) => ({
    props: args,
    template: `<tc-story-date-picker [valueIn]="valueIn" [minIn]="minIn" [maxIn]="maxIn" [noWeekends]="noWeekends"
      [disabled]="disabled" [typed]="typed" [open]="open" />`,
  }),
};

export default meta;
type Story = StoryObj<StoryArgs>;

/** The field alone: a demo date eight days out. */
export const Default: Story = {};
/** The calendar open on the selected day. */
export const Selected: Story = { args: { open: true } };
/** Nothing selected: the calendar opens on today (the dot), «Сегодня» picks it. */
export const Today: Story = { args: { valueIn: null, open: true } };
/** «Перенести демо»: the past cannot be picked (min = today). */
export const DisabledPast: Story = { args: { minIn: 0, open: true } };
/** Min today, max the day before the next demo; the calendar opens on the last month, its next button off. */
export const MinMax: Story = { args: { minIn: 0, maxIn: 20, valueIn: 20, open: true } };
/** Weekends off inside the range: reachable by the arrows, never selectable. */
export const DisabledDays: Story = { args: { minIn: 0, noWeekends: true, open: true } };
/** The keys: → twice, ↓, PageDown; focus is the ring, not the selection. */
export const KeyboardFocus: Story = {
  args: { open: true },
  play: async () => {
    const focused = (): HTMLElement =>
      document.querySelector('.tc-date-panel__day[tabindex="0"]') as HTMLElement;
    await waitFor(() => expect(document.activeElement).toBe(focused()));
    await userEvent.keyboard('{ArrowRight}{ArrowRight}{ArrowDown}{PageDown}');
    await waitFor(() => expect(document.activeElement).toBe(focused()));
  },
};
/** Typed text that is no date: the text stays, the field says how to type it. */
export const TypedError: Story = { args: { typed: '31.02.2026' } };
/** Typed before min: the kit's own min message. */
export const TypedBeforeMin: Story = { args: { minIn: 0, typed: '01.01.2026' } };
/** A disabled field: input and calendar button both off. */
export const DisabledField: Story = { args: { disabled: true } };
/** iPhone: the calendar is a bottom sheet over the page, 44 px cells, «Готово» first in the footer. */
export const Phone: Story = { ...phoneViewport, args: { minIn: 0, open: true } };
export const PhoneField: Story = { ...phoneViewport, args: { minIn: 0 } };
export const English: Story = { globals: { lang: 'en' }, args: { minIn: 0, open: true } };
export const Dark: Story = { ...darkTheme, args: { minIn: 0, open: true } };
export const ReducedMotion: Story = { ...reducedMotion, args: { minIn: 0, open: true } };
