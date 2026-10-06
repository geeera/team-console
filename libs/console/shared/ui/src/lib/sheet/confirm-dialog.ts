import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { Button } from '../button/button';
import { Icon } from '../icon/icon';

/** An optional one-line field in a confirmation (#114: the reason for a pause); its value goes to `action`. */
export interface ConfirmInput {
  readonly label: string;
  readonly hint?: string;
  readonly maxLength?: number;
}

/**
 * Thrown by a confirmation's `action` to say why it did not happen, in words the owner can act on (a rate limit and
 * when to try again). The dialog stays open with the message as an alert; any other error shows `errorMessage`.
 */
export class ConfirmFailure extends Error {
  constructor(message: string) {
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
  imports: [Button, Icon, TranslocoPipe],
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
        <input
          class="tc-confirm__input"
          type="text"
          autocomplete="off"
          enterkeyhint="done"
          [id]="fieldId"
          [attr.maxlength]="field.maxLength ?? null"
          [attr.aria-describedby]="field.hint ? fieldId + '-hint' : null"
          [readOnly]="running()"
          [value]="value()"
          (input)="value.set($any($event.target).value)"
          (keydown.enter)="$event.preventDefault(); confirm()"
        />
        @if (field.hint) {
          <p class="tc-confirm__hint" [id]="fieldId + '-hint'">{{ field.hint }}</p>
        }
      </div>
    }
    @if (failure(); as message) {
      <p class="tc-confirm__error" role="alert"><tc-icon name="alert" size="sm" />{{ message }}</p>
    }
    <div class="tc-confirm__actions tc-dialog-actions">
      <button
        tc-button
        type="button"
        class="tc-confirm__cancel"
        [attr.aria-disabled]="running() ? 'true' : null"
        (click)="cancel()"
      >
        {{ options.cancelLabel || ('ui.confirm.cancel' | transloco) }}
      </button>
      <button
        tc-button
        type="button"
        class="tc-confirm__ok"
        [variant]="options.tone === 'danger' ? 'danger' : 'primary'"
        [loading]="running()"
        [attr.aria-disabled]="running() ? 'true' : null"
        (click)="confirm()"
      >
        @if (running() && options.busyLabel) {
          {{ options.busyLabel }}
        } @else if (failure() !== null) {
          {{ options.retryLabel || ('ui.error.retry' | transloco) }}
        } @else {
          {{ options.confirmLabel || ('ui.confirm.ok' | transloco) }}
        }
      </button>
    </div>
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
  protected readonly value = signal('');

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
    if (this.running()) {
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
      return;
    } finally {
      this.running.set(false);
      this.ref.disableClose = false;
    }
    this.ref.close(true);
  }
}
