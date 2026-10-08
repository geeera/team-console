import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { Button } from '../button/button';
import { DatePicker, type DatePickerProblem } from '../date-picker/date-picker';
import { Icon } from '../icon/icon';
import { SheetFooter } from './sheet-footer';

/**
 * What `ConfirmInput.check` says about the current value, re-evaluated on every keystroke or date pick (#218: the
 * freeze days of a chosen demo date). Already translated.
 */
export interface ConfirmCheck {
  /** Why the value cannot be sent; shown under the field, the field is `aria-invalid` and Confirm does nothing. */
  readonly error?: string;
  /** Replaces the field's `hint` while there is no error. */
  readonly hint?: string;
  /** A caution under the hint in the warning tone; it does not block Confirm. */
  readonly warning?: string;
  /** Confirm's label for this value, e.g. "Move to 16 October". */
  readonly confirmLabel?: string;
  /** The value is valid but sending it changes nothing (the same date): Confirm does nothing. */
  readonly isBlocked?: boolean;
}

/** An optional field in a confirmation (#114: the reason for a pause; #218: a date); its value goes to `action`. */
export interface ConfirmInput {
  readonly label: string;
  readonly hint?: string;
  readonly maxLength?: number;
  /** `date` is the kit's `DatePicker` (`YYYY-MM-DD` values, typed as `ДД.ММ.ГГГГ`); text by default. */
  readonly type?: 'text' | 'date';
  /** The value the field opens with. */
  readonly value?: string;
  /** Bounds of a date field, `YYYY-MM-DD`: days outside are off in the calendar; `check` and the server decide. */
  readonly min?: string;
  readonly max?: string;
  readonly check?: (value: string) => ConfirmCheck;
}

/**
 * Thrown by a confirmation's `action` to say why it did not happen, in words the owner can act on (a rate limit and
 * when to try again). The dialog stays open with the message as an alert; any other error shows `errorMessage`.
 * `refill` replaces the field's value (a conflict: the live value the owner should look at before sending again).
 */
export class ConfirmFailure extends Error {
  constructor(
    message: string,
    readonly refill?: string,
  ) {
    super(message);
    this.name = 'ConfirmFailure';
  }
}

export interface ConfirmOptions {
  readonly title: string;
  readonly message: string;
  /** Points under the message, e.g. what happens to runs in progress. */
  readonly items?: readonly string[];
  /** A quieter second paragraph under the message, e.g. what is left behind. */
  readonly note?: string;
  /** Shown above the message in the danger tone: something to check before confirming. */
  readonly warning?: string;
  readonly input?: ConfirmInput;
  /** Defaults to the kit's "Confirm" / "Cancel". */
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  /** Confirm's label after a failed action; the kit's "Try again" by default. */
  readonly retryLabel?: string;
  /** `danger` for destructive answers such as archiving. */
  readonly tone?: 'default' | 'danger';
  /**
   * The work behind Confirm, given the field's trimmed value ('' without one). While it runs the dialog stays open,
   * Confirm reads `busyLabel` and Escape, the scrim and the close button do nothing; a rejection keeps the dialog
   * open with the `ConfirmFailure` message (or `errorMessage`) as an alert, and Confirm becomes Try again.
   */
  readonly action?: (input: string) => Promise<unknown>;
  readonly busyLabel?: string;
  readonly errorMessage?: string;
}

/** What `ConfirmDialog` receives: the options plus the id `Sheet.confirm()` gave the message for `aria-describedby`. */
export interface ConfirmDialogData extends ConfirmOptions {
  readonly messageId: string;
}

let nextFieldId = 0;

/** The body of `Sheet.confirm()`: warning, message, points, note, optional field, error, Cancel (focused first), Confirm. */
@Component({
  selector: 'tc-confirm-dialog',
  imports: [Button, DatePicker, FormsModule, Icon, SheetFooter, TranslocoPipe],
  template: `
    @if (options.warning) {
      <p class="tc-confirm__warning"><tc-icon name="alert" size="sm" />{{ options.warning }}</p>
    }
    <div class="tc-confirm__text" [id]="options.messageId">
      @if (options.message) {
        <p class="tc-confirm__message">{{ options.message }}</p>
      }
      @if (options.items?.length) {
        <ul class="tc-confirm__items">
          @for (item of options.items; track $index) {
            <li>{{ item }}</li>
          }
        </ul>
      }
    </div>
    @if (options.note) {
      <p class="tc-confirm__note">{{ options.note }}</p>
    }
    @if (options.input; as field) {
      <div class="tc-confirm__field">
        <label class="tc-confirm__label" [for]="fieldId">{{ field.label }}</label>
        @if (field.type === 'date') {
          <tc-date-picker
            class="tc-confirm__date"
            [inputId]="fieldId"
            [label]="field.label"
            [min]="field.min ?? null"
            [max]="field.max ?? null"
            [describedBy]="hasHint() ? fieldId + '-hint' : null"
            [invalid]="!!checked()?.error"
            [readonly]="running()"
            [ngModel]="value()"
            (ngModelChange)="value.set($event ?? '')"
            (problemChange)="pickerProblem.set($event)"
            (keydown.enter)="onDateEnter($event)"
          />
        } @else {
          <input
            class="tc-confirm__input"
            autocomplete="off"
            enterkeyhint="done"
            type="text"
            [id]="fieldId"
            [attr.maxlength]="field.maxLength ?? null"
            [attr.aria-describedby]="hasHint() ? fieldId + '-hint' : null"
            [attr.aria-invalid]="checked()?.error ? 'true' : null"
            [readOnly]="running()"
            [value]="value()"
            (input)="value.set($any($event.target).value)"
            (keydown.enter)="$event.preventDefault(); confirm()"
          />
        }
        @if (field.check || field.type === 'date') {
          <!-- Follows the value: polite, so a freeze range or a refusal is read after the pick, not over it. -->
          <div class="tc-confirm__check" [id]="fieldId + '-hint'" aria-live="polite">
            @if (checked()?.error; as error) {
              <p class="tc-confirm__invalid"><tc-icon name="alert" size="sm" />{{ error }}</p>
            } @else {
              @if (checked()?.hint ?? field.hint; as hint) {
                <p class="tc-confirm__hint">{{ hint }}</p>
              }
              @if (checked()?.warning; as warning) {
                <p class="tc-confirm__caution"><tc-icon name="alert" size="sm" />{{ warning }}</p>
              }
            }
          </div>
        } @else if (field.hint) {
          <p class="tc-confirm__hint" [id]="fieldId + '-hint'">{{ field.hint }}</p>
        }
      </div>
    }
    @if (failure(); as message) {
      <p class="tc-confirm__error" role="alert"><tc-icon name="alert" size="sm" />{{ message }}</p>
    }
    <!-- In the frame's footer, so Cancel and Confirm stay in view however long the text is (#274). -->
    <ng-template tcSheetFooter>
      <button
        tc-button
        type="button"
        class="tc-confirm__ok"
        [variant]="options.tone === 'danger' ? 'danger' : 'primary'"
        [loading]="running()"
        [attr.aria-disabled]="running() || isHeld() ? 'true' : null"
        (click)="confirm()"
      >
        @if (running() && options.busyLabel) {
          {{ options.busyLabel }}
        } @else if (failure() !== null && !isHeld()) {
          {{ options.retryLabel || ('ui.error.retry' | transloco) }}
        } @else {
          {{ checked()?.confirmLabel || options.confirmLabel || ('ui.confirm.ok' | transloco) }}
        }
      </button>
      <button
        tc-button
        type="button"
        class="tc-confirm__cancel"
        [attr.aria-disabled]="running() ? 'true' : null"
        (click)="cancel()"
      >
        {{ options.cancelLabel || ('ui.confirm.cancel' | transloco) }}
      </button>
    </ng-template>
  `,
  styleUrl: './confirm-dialog.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConfirmDialog {
  protected readonly options = inject<ConfirmDialogData>(DIALOG_DATA);
  private readonly ref = inject<DialogRef<boolean>>(DialogRef);
  private readonly transloco = inject(TranslocoService);

  protected readonly fieldId = `tc-confirm-field-${nextFieldId++}`;
  protected readonly running = signal(false);
  /** The alert after a failed action; `null` while none failed. */
  protected readonly failure = signal<string | null>(null);
  protected readonly value = signal(this.options.input?.value ?? '');
  /** The date field's own finding (text that is not a date, a day outside min/max); `null` for a text field. */
  protected readonly pickerProblem = signal<DatePickerProblem | null>(null);
  /**
   * The caller's check, except that text which is not a date is the picker's to explain; the picker's min/max finding
   * shows only when the check found nothing (#307 spec §5: the feature's own messages come first).
   */
  protected readonly checked = computed((): ConfirmCheck | null => {
    const problem = this.pickerProblem();
    if (problem?.kind === 'invalid') {
      return { error: problem.message };
    }
    const checked = this.options.input?.check?.(this.value()) ?? null;
    if (problem !== null && checked?.error === undefined) {
      return { ...checked, error: problem.message };
    }
    return checked;
  });
  /** The field's value cannot be sent as it is: Confirm stays focusable and says nothing new. */
  protected readonly isHeld = computed(() => {
    const checked = this.checked();
    return checked !== null && (checked.error !== undefined || checked.isBlocked === true);
  });
  protected readonly hasHint = computed(
    () =>
      this.options.input?.check !== undefined ||
      this.options.input?.type === 'date' ||
      (this.options.input?.hint ?? '') !== '',
  );

  /** Enter in the typed date sends the form, as in a text field; Enter on the calendar button opens the calendar. */
  protected onDateEnter(event: Event): void {
    if (event.target instanceof HTMLInputElement) {
      event.preventDefault();
      void this.confirm();
    }
  }

  protected cancel(): void {
    if (!this.running()) {
      this.ref.close(false);
    }
  }

  protected async confirm(): Promise<void> {
    const action = this.options.action;
    if (action === undefined) {
      this.ref.close(true);
      return;
    }
    if (this.running() || this.isHeld()) {
      return;
    }
    this.running.set(true);
    this.failure.set(null);
    // aria-disabled, not disabled: the focused Confirm keeps focus while the work runs.
    this.ref.disableClose = true;
    try {
      await action(this.value().trim());
    } catch (error: unknown) {
      // The caller's action owns its own logging; the dialog only says why it did not happen.
      this.failure.set(
        error instanceof ConfirmFailure
          ? error.message
          : this.options.errorMessage || this.transloco.translate('ui.error.title'),
      );
      if (error instanceof ConfirmFailure && error.refill !== undefined) {
        this.value.set(error.refill);
      }
      return;
    } finally {
      this.running.set(false);
      this.ref.disableClose = false;
    }
    this.ref.close(true);
  }
}
