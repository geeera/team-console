import { ComponentType } from '@angular/cdk/portal';
import { Dialog, DialogRef } from '@angular/cdk/dialog';
import { BreakpointObserver } from '@angular/cdk/layout';
import { Overlay } from '@angular/cdk/overlay';
import { DOCUMENT } from '@angular/common';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { BREAKPOINTS } from '../../tokens/breakpoints';
import { ConfirmDialog, ConfirmDialogData, ConfirmOptions } from './confirm-dialog';
import { SHEET_FRAME, SheetContainer, SheetFrame } from './sheet-container';
import { SheetFooterSlot } from './sheet-footer';
import { SheetScrollLocks, SheetScrollStrategy } from './sheet-scroll-lock';

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
  /** `wide` gives the centred dialog `--sheet-dialog-w` instead of the confirmation width; the sheet is full width. */
  readonly width?: 'default' | 'wide';
}

let nextSheetId = 0;

/**
 * The console's one dialog shell (#274): opens kit content as a bottom sheet on the phone or a centred dialog on
 * wider screens, on top of the CDK dialog — focus trap, Escape and scrim tap close, focus returns to the opener. The
 * frame fits the visual viewport, keeps its title and its `tcSheetFooter` actions in view and scrolls only its body;
 * the page behind (every `.tc-page-scroll`) and any sheet underneath hold still while it is open.
 */
@Injectable({ providedIn: 'root' })
export class Sheet {
  private readonly dialog = inject(Dialog);
  private readonly overlay = inject(Overlay);
  private readonly breakpoints = inject(BreakpointObserver);
  private readonly scrollLocks = new SheetScrollLocks(inject(DOCUMENT).documentElement);

  open<R = unknown, D = unknown>(content: ComponentType<unknown>, options: SheetOptions<D>): DialogRef<R> {
    const presentation = this.breakpoints.isMatched(BREAKPOINTS.phone) ? 'sheet' : 'dialog';
    const frame: SheetFrame = {
      title: options.title,
      titleId: `tc-sheet-title-${nextSheetId++}`,
      presentation,
    };
    const position = this.overlay.position().global().centerHorizontally();
    // One footer slot per sheet, shared by the frame (which renders it) and the content (which fills it).
    const footer = new SheetFooterSlot();
    const dialogPanel =
      options.width === 'wide' ? ['tc-dialog-panel', 'tc-dialog-panel--wide'] : 'tc-dialog-panel';

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
      panelClass: presentation === 'sheet' ? 'tc-sheet-panel' : dialogPanel,
      positionStrategy: presentation === 'sheet' ? position.bottom('0') : position.centerVertically(),
      scrollStrategy: new SheetScrollStrategy(this.scrollLocks),
      providers: [{ provide: SheetFooterSlot, useValue: footer }],
      container: {
        type: SheetContainer,
        providers: () => [
          { provide: SHEET_FRAME, useValue: frame },
          { provide: SheetFooterSlot, useValue: footer },
        ],
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
