import { CdkTrapFocus } from '@angular/cdk/a11y';
import { DIALOG_DATA } from '@angular/cdk/dialog';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  signal,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { Button, IconButton } from '../button/button';
import { Icon } from '../icon/icon';
import { SheetFooter } from '../sheet/sheet-footer';
import { calendarKeyAction } from './calendar-keys';
import { calendarNamesOf, type CalendarNames } from './calendar-names';
import { addMonths, isMonthOutOfBounds, isOutOfBounds, isSameMonth, monthGridOf, type DayBounds } from './date-math';

/** What the field hands the calendar it opens; `close` ends it — with a day to commit, or `null` to change nothing. */
export interface DatePickerPanelData {
  readonly presentation: 'popover' | 'sheet';
  readonly selected: string | null;
  /** The day focus starts on: the selected one, else today, else the first available day. */
  readonly start: string;
  readonly today: string;
  readonly bounds: DayBounds;
  readonly isDateDisabled: (day: string) => boolean;
  readonly lang: string;
  readonly close: (day: string | null) => void;
}

interface DayCell {
  readonly day: string;
  readonly date: number;
  readonly label: string;
  readonly isToday: boolean;
  readonly isUnavailable: boolean;
}

let nextPanelId = 0;

/**
 * The calendar behind `DatePicker` (#307): month heading with prev/next, a Monday-first grid with a roving tab stop
 * and the APG date-picker keys, and «Сегодня» / «Готово». A popover on the Mac (its own `role="dialog"`, focus
 * trapped here) or the body of a `Sheet` on the phone (the sheet is the dialog, the actions go to its footer).
 * Picking a day only selects it; Enter on a day or «Готово» commits, everything else closes without a change.
 */
@Component({
  selector: 'tc-date-picker-panel',
  imports: [Button, CdkTrapFocus, Icon, IconButton, NgTemplateOutlet, SheetFooter, TranslocoPipe],
  templateUrl: './date-picker-panel.html',
  styleUrl: './date-picker-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'tc-date-panel',
    '[class.tc-date-panel--sheet]': 'isSheet',
    '[class.tc-date-panel--closing]': 'isClosing()',
    '[attr.role]': 'isSheet ? null : "dialog"',
    '[attr.aria-modal]': 'isSheet ? null : "true"',
    '[attr.aria-labelledby]': 'isSheet ? null : headingId',
    '(keydown.escape)': 'onEscape($event)',
  },
})
export class DatePickerPanel {
  protected readonly data = inject<DatePickerPanelData>(DIALOG_DATA);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  protected readonly isSheet = this.data.presentation === 'sheet';
  protected readonly headingId = `tc-date-panel-${nextPanelId++}-month`;
  protected readonly names: CalendarNames = calendarNamesOf(this.data.lang, {
    todayMark: inject(TranslocoService).translate('ui.datePicker.todayMark'),
    unavailable: inject(TranslocoService).translate('ui.datePicker.unavailable'),
  });

  /** The day that is (or would be) committed. */
  protected readonly selected = signal<string | null>(this.data.selected);
  /** The grid's one tab stop; its month is the month on screen. */
  protected readonly focused = signal(this.data.start);
  /** Set by the field while the popover plays its exit. */
  readonly isClosing = signal(false);

  protected readonly monthLabel = computed(() => this.names.month(this.focused()));
  protected readonly weeks = computed(() =>
    monthGridOf(this.focused()).map((week) => week.map((day) => (day === null ? null : this.cellOf(day)))),
  );
  /** One entry, re-created per month, so the grid cross-fades on a month change. */
  protected readonly shownMonth = computed(() => [this.focused().slice(0, 7)]);
  protected readonly isPrevOff = computed(() => isMonthOutOfBounds(addMonths(this.focused(), -1), this.data.bounds));
  protected readonly isNextOff = computed(() => isMonthOutOfBounds(addMonths(this.focused(), 1), this.data.bounds));
  protected readonly isTodayOff = computed(() => this.isUnavailable(this.data.today));

  constructor() {
    if (!this.isSheet) {
      // The sheet focuses the start day itself (`autoFocus`); the popover does it once it is on screen.
      this.focusCell();
    }
  }

  protected isUnavailable(day: string): boolean {
    return isOutOfBounds(day, this.data.bounds) || this.data.isDateDisabled(day);
  }

  protected showMonth(step: -1 | 1): void {
    const target = addMonths(this.focused(), step);
    // Keep the tab stop on an in-range day of the new month, so Tab into the grid lands somewhere sensible.
    this.focused.set(isOutOfBounds(target, this.data.bounds) ? this.firstInRangeOf(target) : target);
  }

  protected pick(cell: DayCell): void {
    this.focused.set(cell.day);
    if (!cell.isUnavailable) {
      this.selected.set(cell.day);
    }
  }

  protected onGridKeydown(event: KeyboardEvent): void {
    const action = calendarKeyAction(event, this.focused(), this.data.bounds);
    if (action === null) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (action.kind === 'move') {
      this.focused.set(action.day);
      this.focusCell();
      return;
    }
    const day = this.focused();
    if (this.isUnavailable(day)) {
      return;
    }
    this.selected.set(day);
    if (action.close) {
      this.data.close(day);
    }
  }

  protected selectToday(): void {
    if (this.isTodayOff()) {
      return;
    }
    this.selected.set(this.data.today);
    this.focused.set(this.data.today);
  }

  protected done(): void {
    this.data.close(this.selected());
  }

  protected onEscape(event: Event): void {
    // In a sheet the CDK dialog owns Escape; the popover closes itself and keeps it from the dialog underneath.
    if (!this.isSheet) {
      event.preventDefault();
      event.stopPropagation();
      this.data.close(null);
    }
  }

  private cellOf(day: string): DayCell {
    const isToday = day === this.data.today;
    const isUnavailable = this.isUnavailable(day);
    const label = [this.names.fullDay(day), isToday ? this.names.todayMark : '', isUnavailable ? this.names.unavailable : '']
      .filter((part) => part !== '')
      .join(', ');
    return { day, date: Number(day.slice(8, 10)), label, isToday, isUnavailable };
  }

  /** The first day of `day`'s month that is inside the bounds (the month has one: its button was on). */
  private firstInRangeOf(day: string): string {
    const { min, max } = this.data.bounds;
    if (min !== null && isSameMonth(day, min) && day < min) {
      return min;
    }
    if (max !== null && isSameMonth(day, max) && day > max) {
      return max;
    }
    return day;
  }

  private focusCell(): void {
    afterNextRender(
      () => {
        const cell = this.host.nativeElement.querySelector<HTMLElement>('.tc-date-panel__day[tabindex="0"]');
        cell?.focus();
      },
      { injector: this.injector },
    );
  }

}
