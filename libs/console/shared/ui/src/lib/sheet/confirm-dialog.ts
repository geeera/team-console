import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { TranslocoPipe } from '@console/shared/i18n';
import { Button } from '../button/button';

export interface ConfirmOptions {
  readonly title: string;
  readonly message: string;
  /** A quieter second paragraph under the message, e.g. what is left behind. */
  readonly note?: string;
  /** Defaults to the kit's "Confirm" / "Cancel". */
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  /** `danger` for destructive answers such as archiving. */
  readonly tone?: 'default' | 'danger';
  /**
   * The work behind Confirm. While it runs the dialog stays open, Confirm reads `busyLabel` and Escape, the scrim
   * and the close button do nothing; a rejection keeps the dialog open with `errorMessage` as an alert.
   */
  readonly action?: () => Promise<unknown>;
  readonly busyLabel?: string;
  readonly errorMessage?: string;
}

/** What `ConfirmDialog` receives: the options plus the id `Sheet.confirm()` gave the message for `aria-describedby`. */
export interface ConfirmDialogData extends ConfirmOptions {
  readonly messageId: string;
}

/** The body of `Sheet.confirm()`: message, optional note, Cancel (focused first), Confirm. */
@Component({
  selector: 'tc-confirm-dialog',
  imports: [Button, TranslocoPipe],
  template: `
    <p class="tc-confirm__message" [id]="options.messageId">{{ options.message }}</p>
    @if (options.note) {
      <p class="tc-confirm__note">{{ options.note }}</p>
    }
    @if (failed()) {
      <p class="tc-confirm__error" role="alert">
        {{ options.errorMessage || ('ui.error.title' | transloco) }}
      </p>
    }
    <div class="tc-confirm__actions">
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

  protected readonly running = signal(false);
  protected readonly failed = signal(false);

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
    this.failed.set(false);
    // aria-disabled, not disabled: the focused Confirm keeps focus while the work runs.
    this.ref.disableClose = true;
    try {
      await action();
    } catch {
      // The caller's action owns its own logging; the dialog only reports that it did not happen.
      this.failed.set(true);
      return;
    } finally {
      this.running.set(false);
      this.ref.disableClose = false;
    }
    this.ref.close(true);
  }
}
