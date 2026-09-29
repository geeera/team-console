import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslocoPipe } from '@console/shared/i18n';
import { Button } from '../button/button';

export interface ConfirmOptions {
  readonly title: string;
  readonly message: string;
  /** Defaults to the kit's "Confirm" / "Cancel". */
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  /** `danger` for destructive answers such as archiving. */
  readonly tone?: 'default' | 'danger';
}

/** The body of `Sheet.confirm()`: message, Cancel (focused first), Confirm. */
@Component({
  selector: 'tc-confirm-dialog',
  imports: [Button, TranslocoPipe],
  template: `
    <p class="tc-confirm__message">{{ options.message }}</p>
    <div class="tc-confirm__actions">
      <button tc-button type="button" class="tc-confirm__cancel" (click)="ref.close(false)">
        {{ options.cancelLabel || ('ui.confirm.cancel' | transloco) }}
      </button>
      <button
        tc-button
        type="button"
        class="tc-confirm__ok"
        [variant]="options.tone === 'danger' ? 'danger' : 'primary'"
        (click)="ref.close(true)"
      >
        {{ options.confirmLabel || ('ui.confirm.ok' | transloco) }}
      </button>
    </div>
  `,
  styleUrl: './confirm-dialog.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConfirmDialog {
  protected readonly options = inject<ConfirmOptions>(DIALOG_DATA);
  protected readonly ref = inject<DialogRef<boolean>>(DialogRef);
}
