import { ComponentType } from '@angular/cdk/portal';
import { Dialog, DialogRef } from '@angular/cdk/dialog';
import { BreakpointObserver } from '@angular/cdk/layout';
import { Overlay } from '@angular/cdk/overlay';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { BREAKPOINTS } from '../../tokens/breakpoints';
import { ConfirmDialog, ConfirmDialogData, ConfirmOptions } from './confirm-dialog';
import { SHEET_FRAME, SheetContainer, SheetFrame } from './sheet-container';

export interface SheetOptions<D> {
  /** Already translated; becomes the heading and the dialog's accessible name. */
  readonly title: string;
  /** Injected into the content component as `DIALOG_DATA`. */
  readonly data?: D;
  /** `alertdialog` for confirmations that interrupt; the default is a plain dialog. */
  readonly role?: 'dialog' | 'alertdialog';
  /** A CSS selector inside the content to focus first; the heading by default. */
  readonly autoFocus?: string;
  /** The id of an element inside the content that describes the dialog (`aria-describedby`). */
  readonly describedBy?: string;
}

let nextSheetId = 0;

/**
 * Opens kit content as a bottom sheet on the phone or a centred dialog on wider screens, on
 * top of the CDK dialog: focus trap, Escape and scrim tap close, focus returns to the opener.
 */
@Injectable({ providedIn: 'root' })
export class Sheet {
  private readonly dialog = inject(Dialog);
  private readonly overlay = inject(Overlay);
  private readonly breakpoints = inject(BreakpointObserver);

  open<R = unknown, D = unknown>(content: ComponentType<unknown>, options: SheetOptions<D>): DialogRef<R> {
    const presentation = this.breakpoints.isMatched(BREAKPOINTS.phone) ? 'sheet' : 'dialog';
    const frame: SheetFrame = {
      title: options.title,
      titleId: `tc-sheet-title-${nextSheetId++}`,
      presentation,
    };
    const position = this.overlay.position().global().centerHorizontally();

    return this.dialog.open<R, D, unknown>(content, {
      data: options.data ?? null,
      role: options.role ?? 'dialog',
      ariaModal: true,
      ariaLabelledBy: frame.titleId,
      ariaDescribedBy: options.describedBy ?? null,
      autoFocus: options.autoFocus ?? '.tc-sheet__title',
      restoreFocus: true,
      hasBackdrop: true,
      backdropClass: 'tc-scrim',
      panelClass: presentation === 'sheet' ? 'tc-sheet-panel' : 'tc-dialog-panel',
      positionStrategy: presentation === 'sheet' ? position.bottom('0') : position.centerVertically(),
      scrollStrategy: this.overlay.scrollStrategies.block(),
      container: {
        type: SheetContainer,
        providers: () => [{ provide: SHEET_FRAME, useValue: frame }],
      },
    });
  }

  /**
   * Resolves `true` only when the user pressed Confirm and its `action`, if any, succeeded; Escape, the scrim and
   * Cancel give `false`. A failed action keeps the dialog open, so the promise waits for the next answer.
   */
  async confirm(options: ConfirmOptions): Promise<boolean> {
    const messageId = `tc-confirm-message-${nextSheetId++}`;
    const ref = this.open<boolean, ConfirmDialogData>(ConfirmDialog, {
      title: options.title,
      data: { ...options, messageId },
      role: 'alertdialog',
      autoFocus: '.tc-confirm__cancel',
      describedBy: messageId,
    });
    const result = await firstValueFrom(ref.closed);
    return result === true;
  }
}
