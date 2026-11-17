import { ChangeDetectionStrategy, Component, computed, effect, input, output, signal } from '@angular/core';
import { Field, FieldControl } from '@console/shared/ui';
import { boundedIntegerOf } from '../team-fields';

/**
 * A bounded whole number of the team setup (#688): the typed text stays as typed, a valid value goes to the draft at
 * once, an invalid one stays on screen with the range as its error and never reaches the draft. `allowEmpty` makes
 * an empty field a value of its own (`null`: the budget's "no limit"). Read-only shows the value as text.
 */
@Component({
  selector: 'tc-team-number',
  imports: [Field, FieldControl],
  template: `
    @if (readOnly()) {
      <div class="number__read">
        <span class="number__label">{{ label() }}</span>
        <span class="number__value" [attr.data-testid]="'value-' + path()">{{ shown() }}</span>
      </div>
    } @else {
      <tc-field [label]="label()" [hint]="hint()" [note]="note()" [error]="errorText()">
        <input
          tcInput
          type="text"
          inputmode="numeric"
          autocomplete="off"
          class="number__input"
          [attr.data-control]="path()"
          [attr.data-testid]="'input-' + path()"
          [attr.placeholder]="placeholder()"
          [value]="text()"
          (input)="onInput($event)"
        />
      </tc-field>
    }
  `,
  styles: `
    .number__read {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: var(--space-2);
    }

    .number__label {
      color: var(--text-2);
    }

    .number__value {
      font-weight: var(--fw-semibold);
    }

    .number__input {
      max-width: calc(var(--control-h-touch) * 4);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'number' },
})
export class NumberField {
  /** The document path, for the 422 focus and the test hooks. */
  readonly path = input.required<string>();
  readonly label = input.required<string>();
  readonly hint = input('');
  readonly note = input('');
  readonly placeholder = input<string | null>(null);
  readonly value = input.required<number | null>();
  readonly min = input.required<number>();
  readonly max = input.required<number>();
  readonly allowEmpty = input(false);
  readonly readOnly = input(false);
  /** The worded error from the page (a 422 on this path); the range error is this field's own. */
  readonly error = input<string | null>(null);
  /** The empty value in words for read-only ("no limit"). */
  readonly emptyText = input('');
  /** Bumped by the page when it drops every edit (Discard): typed text goes even if the value did not change. */
  readonly epoch = input(0);
  /** The range error, already worded with `min` and `max`. */
  readonly rangeText = input.required<string>();

  /** A valid value: a whole number inside the bound, or `null` when empty is allowed. */
  readonly valueChange = output<number | null>();
  /** The typed text is invalid (`true`) or valid again (`false`), for the page to block the review. */
  readonly typedInvalid = output<boolean>();

  private readonly typed = signal<string | null>(null);
  protected readonly text = computed(() => this.typed() ?? (this.value() === null ? '' : String(this.value())));
  protected readonly isRangeError = signal(false);
  protected readonly errorText = computed(() => (this.isRangeError() ? this.rangeText() : (this.error() ?? '')));
  protected readonly shown = computed(() => {
    const value = this.value();
    return value === null ? this.emptyText() : String(value);
  });

  constructor() {
    // A value set from outside (Discard, a preset, a merge) replaces whatever was typed.
    effect(() => {
      this.value();
      this.epoch();
      this.typed.set(null);
      this.isRangeError.set(false);
    });
  }

  protected onInput(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }
    const text = target.value;
    const parsed = text.trim() === '' && this.allowEmpty() ? null : boundedIntegerOf(text, this.min(), this.max());
    const isValid = parsed !== null || (text.trim() === '' && this.allowEmpty());
    this.isRangeError.set(!isValid);
    this.typedInvalid.emit(!isValid);
    if (isValid) {
      this.typed.set(null);
      this.valueChange.emit(parsed);
    } else {
      this.typed.set(text);
    }
  }
}
