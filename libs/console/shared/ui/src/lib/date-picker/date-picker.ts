import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { BreakpointObserver } from '@angular/cdk/layout';
import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { DOCUMENT } from '@angular/common';
import {
  afterNextRender,
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  forwardRef,
  inject,
  Injector,
  input,
  output,
  signal,
  viewChild,
  type ComponentRef,
} from '@angular/core';
import {
  NG_VALIDATORS,
  NG_VALUE_ACCESSOR,
  type ControlValueAccessor,
  type ValidationErrors,
  type Validator,
} from '@angular/forms';
import { TranslocoService } from '@console/shared/i18n';
import { isCalendarDate } from '@shared/contracts';
import { Subscription } from 'rxjs';
import { BREAKPOINTS } from '../../tokens/breakpoints';
import { IconButton } from '../button/button';
import { Field } from '../field/field';
import { Icon } from '../icon/icon';
import { Sheet } from '../sheet/sheet';
import { DatePickerPanel, type DatePickerPanelData } from './date-picker-panel';
import {
  firstAvailableFrom,
  formatTypedDay,
  isOutOfBounds,
  localTodayOf,
  parseTypedDay,
  type DayBounds,
} from './date-math';

/** Why the typed or picked value is not acceptable to the picker itself (the caller's own checks come first). */
export type DatePickerProblemKind = 'invalid' | 'min' | 'max' | 'unavailable';

export interface DatePickerProblem {
  readonly kind: DatePickerProblemKind;
  /** Already translated, for the field's error line. */
  readonly message: string;
}

/**
 * The kit's date field (#307): a text input that takes `ДД.ММ.ГГГГ` (or ISO, `/`, `-`, spaces) and a calendar button
 * that opens a popover on a wider screen and a bottom sheet on the phone. The value is an ISO calendar day
 * (`YYYY-MM-DD`) or `null`, through `ControlValueAccessor`; typed text is read on blur and Enter, never per keystroke.
 *
 * Inside `tc-field` it takes the field's id, description and error; elsewhere (a confirmation with its own label and
 * check lines) `inputId`, `describedBy` and `invalid` say the same. Its own problems — text that is not a date, a day
 * outside min/max or a disabled one — are `problem()` (and `problemChange`), and a validator error for forms.
 *
 * ```html
 * <tc-field [label]="t('demo.label')" [error]="demo.problem()?.message ?? ''">
 *   <tc-date-picker #demo [label]="t('demo.label')" [min]="today" [(ngModel)]="due" />
 * </tc-field>
 * ```
 */
@Component({
  selector: 'tc-date-picker',
  imports: [Icon, IconButton],
  templateUrl: './date-picker.html',
  styleUrl: './date-picker.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    { provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => DatePicker), multi: true },
    { provide: NG_VALIDATORS, useExisting: forwardRef(() => DatePicker), multi: true },
  ],
  host: {
    class: 'tc-date-picker',
    '[class.tc-date-picker--disabled]': 'isDisabled()',
  },
})
export class DatePicker implements ControlValueAccessor, Validator {
  /** Already translated: the sheet's title on the phone (the field's label). Falls back to the enclosing field's. */
  readonly label = input<string>('');
  /** Bounds, `YYYY-MM-DD`, both inclusive. */
  readonly min = input<string | null>(null);
  readonly max = input<string | null>(null);
  /** Days inside the bounds that cannot be picked. */
  readonly isDateDisabled = input<(day: string) => boolean>(() => false);
  /** "Today" in the calendar; the device's day by default. */
  readonly today = input<string | null>(null);
  readonly disabled = input(false, { transform: booleanAttribute });
  readonly readonly = input(false, { transform: booleanAttribute });
  /** Outside `tc-field`: the input's id, its description and whether the caller found the value wrong. */
  readonly inputId = input<string | null>(null);
  readonly describedBy = input<string | null>(null);
  readonly invalid = input(false, { transform: booleanAttribute });

  readonly problemChange = output<DatePickerProblem | null>();

  protected readonly field = inject(Field, { optional: true });
  private readonly overlay = inject(Overlay);
  private readonly sheet = inject(Sheet);
  private readonly breakpoints = inject(BreakpointObserver);
  private readonly transloco = inject(TranslocoService);
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);

  private readonly group = viewChild.required<ElementRef<HTMLElement>>('group');
  private readonly toggleButton = viewChild.required('toggleButton', { read: ElementRef<HTMLButtonElement> });
  private readonly textInput = viewChild.required<ElementRef<HTMLInputElement>>('textInput');

  /** The committed value. */
  readonly value = signal<string | null>(null);
  /** What the input shows: the value's typed form, or what the owner typed. */
  protected readonly text = signal('');
  private readonly problemState = signal<DatePickerProblem | null>(null);
  readonly problem = this.problemState.asReadonly();
  protected readonly isOpen = signal(false);
  private readonly formDisabled = signal(false);
  /** The last day that was valid, so a calendar opened over a typo starts on a sensible month. */
  private lastValid: string | null = null;

  protected readonly isDisabled = computed(() => this.disabled() || this.formDisabled());
  protected readonly controlId = computed(() => this.inputId() ?? this.field?.controlId ?? null);
  protected readonly describedByIds = computed(() => this.describedBy() ?? this.field?.describedBy() ?? null);
  protected readonly isInvalid = computed(
    () => this.invalid() || this.problemState() !== null || (this.field?.error() ?? '') !== '',
  );
  protected readonly placeholder = computed(() => this.t('ui.datePicker.placeholder'));
  protected readonly toggleLabel = computed(() => {
    const value = this.value();
    return value === null
      ? this.t('ui.datePicker.open')
      : this.t('ui.datePicker.openWith', { date: formatTypedDay(value) });
  });

  private onChange: (value: string | null) => void = () => undefined;
  private onTouched: () => void = () => undefined;
  private onValidatorChange: () => void = () => undefined;
  private popover: { ref: OverlayRef; panel: ComponentRef<DatePickerPanel>; events: Subscription } | null =
    null;
  private sheetRef: DialogRef<string | null> | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.disposePopover();
      this.sheetRef?.close();
    });
  }

  writeValue(value: unknown): void {
    const day = isCalendarDate(value) ? value : null;
    // An echo of what the field just reported (`''` back for its `null`) keeps the text as typed and its problem.
    if (day === this.value() && (day !== null || this.text() !== '')) {
      return;
    }
    this.value.set(day);
    this.text.set(day === null ? '' : formatTypedDay(day));
    this.lastValid = day;
    this.setProblem(day === null ? null : this.problemOf(day));
  }

  registerOnChange(fn: (value: string | null) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.formDisabled.set(isDisabled);
  }

  validate(): ValidationErrors | null {
    const problem = this.problemState();
    return problem === null ? null : { datePicker: { kind: problem.kind } };
  }

  registerOnValidatorChange(fn: () => void): void {
    this.onValidatorChange = fn;
  }

  protected onInput(event: Event): void {
    this.text.set((event.target as HTMLInputElement).value);
  }

  protected onBlur(): void {
    this.commitText();
    this.onTouched();
  }

  protected onInputKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      // Committed first; the event then goes on to the form or dialog around the field.
      this.commitText();
      return;
    }
    if (event.key === 'ArrowDown' && event.altKey) {
      event.preventDefault();
      this.open();
    }
  }

  protected toggle(): void {
    if (this.isOpen()) {
      this.closePopover(null, true);
      return;
    }
    this.open();
  }

  /** Opens the calendar: a popover anchored to the field, or a sheet on the phone. */
  open(): void {
    if (this.isOpen() || this.isDisabled() || this.readonly()) {
      return;
    }
    const bounds = this.bounds();
    const today = this.todayDay();
    const isUnavailable = (day: string): boolean => isOutOfBounds(day, bounds) || this.isDateDisabled()(day);
    const selected = this.value();
    const start =
      selected ??
      this.lastValid ??
      firstAvailableFrom(isUnavailable(today) ? (bounds.min ?? today) : today, isUnavailable);
    const presentation = this.breakpoints.isMatched(BREAKPOINTS.phone) ? 'sheet' : 'popover';
    const data: Omit<DatePickerPanelData, 'close'> = {
      presentation,
      selected,
      start,
      today,
      bounds,
      isDateDisabled: this.isDateDisabled(),
      lang: this.transloco.getActiveLang(),
    };
    this.isOpen.set(true);
    if (presentation === 'sheet') {
      this.openSheet(data);
    } else {
      this.openPopover(data);
    }
  }

  private openSheet(data: Omit<DatePickerPanelData, 'close'>): void {
    const ref = this.sheet.open<string | null, DatePickerPanelData>(DatePickerPanel, {
      title: this.label() || this.field?.label() || this.t('ui.datePicker.open'),
      data: { ...data, close: (day) => ref.close(day) },
      autoFocus: '.tc-date-panel__day[tabindex="0"]',
    });
    this.sheetRef = ref;
    ref.closed.subscribe((day) => {
      this.sheetRef = null;
      this.isOpen.set(false);
      if (typeof day === 'string') {
        this.commit(day);
      }
      this.returnFocus();
    });
  }

  private openPopover(data: Omit<DatePickerPanelData, 'close'>): void {
    const spacing = this.spaceToken('--space-1');
    const ref = this.overlay.create({
      positionStrategy: this.overlay
        .position()
        .flexibleConnectedTo(this.group())
        .withPositions([
          { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top', offsetY: spacing },
          { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'bottom', offsetY: -spacing },
          { originX: 'end', originY: 'bottom', overlayX: 'end', overlayY: 'top', offsetY: spacing },
          { originX: 'end', originY: 'top', overlayX: 'end', overlayY: 'bottom', offsetY: -spacing },
        ])
        .withPush(true)
        .withViewportMargin(spacing),
      scrollStrategy: this.overlay.scrollStrategies.reposition(),
      panelClass: 'tc-date-popover-pane',
    });
    const injector = Injector.create({
      parent: this.injector,
      providers: [
        {
          provide: DIALOG_DATA,
          useValue: { ...data, close: (day: string | null) => this.closePopover(day, true) },
        },
      ],
    });
    const panel = ref.attach(new ComponentPortal(DatePickerPanel, null, injector));
    const events = new Subscription();
    // A keydown subscription makes the popover the overlay the CDK sends Escape to, so the dialog under it stays open;
    // the panel itself handles the key.
    events.add(ref.keydownEvents().subscribe());
    events.add(
      ref.outsidePointerEvents().subscribe((event) => {
        const target = event.target instanceof Node ? event.target : null;
        if (target === null || !this.group().nativeElement.contains(target)) {
          this.closePopover(null, false);
        }
      }),
    );
    this.popover = { ref, panel, events };
  }

  private closePopover(day: string | null, shouldReturnFocus: boolean): void {
    const popover = this.popover;
    if (popover === null) {
      return;
    }
    this.popover = null;
    this.isOpen.set(false);
    if (day !== null) {
      this.commit(day);
    }
    if (shouldReturnFocus) {
      this.returnFocus();
    }
    popover.events.unsubscribe();
    popover.panel.instance.isClosing.set(true);
    void this.afterExit(popover.panel.location.nativeElement).then(() => popover.ref.dispose());
  }

  private disposePopover(): void {
    this.popover?.events.unsubscribe();
    this.popover?.ref.dispose();
    this.popover = null;
  }

  /** Waits for the popover's exit animation; at once where there is none (reduced motion is 1 ms, jsdom has none). */
  private async afterExit(element: HTMLElement): Promise<void> {
    await new Promise<void>((resolve) => afterNextRender(() => resolve(), { injector: this.injector }));
    if (typeof element.getAnimations !== 'function') {
      return;
    }
    // Settled, not all: a cancelled exit rejects `finished`, and the popover goes either way.
    await Promise.allSettled(element.getAnimations().map((animation) => animation.finished));
  }

  private commit(day: string): void {
    this.lastValid = day;
    this.text.set(formatTypedDay(day));
    this.setProblem(this.problemOf(day));
    if (day !== this.value()) {
      this.value.set(day);
      this.onChange(day);
    }
  }

  private commitText(): void {
    const text = this.text().trim();
    if (text === '') {
      this.lastValid = null;
      this.setProblem(null);
      if (this.value() !== null) {
        this.value.set(null);
        this.onChange(null);
      }
      return;
    }
    const day = parseTypedDay(text);
    if (day === null) {
      // The text stays as typed so it can be fixed; the value is gone until it reads as a date.
      this.setProblem({
        kind: 'invalid',
        message: this.t('ui.datePicker.invalid', { example: formatTypedDay(this.todayDay()) }),
      });
      if (this.value() !== null) {
        this.value.set(null);
        this.onChange(null);
      }
      return;
    }
    this.commit(day);
  }

  /** Out of bounds or disabled days are still the value: the caller's own check may explain them better. */
  private problemOf(day: string): DatePickerProblem | null {
    const { min, max } = this.bounds();
    if (min !== null && day < min) {
      return { kind: 'min', message: this.t('ui.datePicker.min', { date: formatTypedDay(min) }) };
    }
    if (max !== null && day > max) {
      return { kind: 'max', message: this.t('ui.datePicker.max', { date: formatTypedDay(max) }) };
    }
    if (this.isDateDisabled()(day)) {
      return { kind: 'unavailable', message: this.t('ui.datePicker.unavailableDay') };
    }
    return null;
  }

  private setProblem(problem: DatePickerProblem | null): void {
    const current = this.problemState();
    if (current?.kind === problem?.kind && current?.message === problem?.message) {
      return;
    }
    this.problemState.set(problem);
    this.problemChange.emit(problem);
    this.onValidatorChange();
  }

  private returnFocus(): void {
    // After the CDK has put focus back where the dialog opened from (the input, after Alt+↓).
    afterNextRender(() => this.toggleButton().nativeElement.focus(), { injector: this.injector });
  }

  private bounds(): DayBounds {
    const min = this.min();
    const max = this.max();
    return { min: isCalendarDate(min) ? min : null, max: isCalendarDate(max) ? max : null };
  }

  private todayDay(): string {
    const today = this.today();
    return isCalendarDate(today) ? today : localTodayOf(new Date());
  }

  /** A spacing token in px, for the CDK's numeric offsets; 0 when it cannot be read. */
  private spaceToken(name: string): number {
    const view = this.document.defaultView;
    const value =
      view === null
        ? NaN
        : parseFloat(view.getComputedStyle(this.document.documentElement).getPropertyValue(name));
    return Number.isFinite(value) ? value : 0;
  }

  private t(key: string, params?: Record<string, unknown>): string {
    return this.transloco.translate(key, params);
  }

  /** For callers that focus the field (a story's play, a dialog's autoFocus). */
  focus(): void {
    this.textInput().nativeElement.focus();
  }
}
