import { ComponentType } from '@angular/cdk/portal';
import { Dialog, DialogRef } from '@angular/cdk/dialog';
import { BreakpointObserver } from '@angular/cdk/layout';
import { Overlay } from '@angular/cdk/overlay';
import { DOCUMENT } from '@angular/common';
import { inject, Injectable, isSignal, type Signal, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { BREAKPOINTS } from '../../tokens/breakpoints';
import { ConfirmDialog, ConfirmDialogData, ConfirmOptions } from './confirm-dialog';
import { OpenSheets } from './open-sheets';
import { SHEET_FRAME, SheetContainer, SheetFrame } from './sheet-container';
import { SheetCloseGuard } from './sheet-close-guard';
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
  /**
   * `wide` gives the centred dialog `--sheet-dialog-w` instead of the confirmation width, `task` the New task form's
   * `--task-dialog-w` (#107); the sheet is full width.
   */
  readonly width?: 'default' | 'wide' | 'task';
  /** A quieter line under the title, e.g. where the result goes («в team-console»); part of the accessible name. */
  readonly subtitle?: string | Signal<string>;
  /**
   * #107: on the phone the content's primary footer action moves into the head, beside the title, where the keyboard
   * never covers it, and Close becomes a text button at the start. The dialog keeps both in the footer.
   */
  readonly headAction?: boolean;
  /**
   * `full` (#277): the sheet takes the whole screen on the phone and the dialog `--sheet-full-w × --sheet-full-h`
   * (within the viewport) elsewhere. The body then no longer scrolls or pads: the content fills it as a column and
   * owns the one scroller on screen. Takes precedence over `width`.
   */
  readonly size?: 'default' | 'full';
}

let nextSheetId = 0;

/** A fixed subtitle, or one that follows the content (#107: «в <project>» as the project picker changes). */
function subtitleOf(subtitle: string | Signal<string> | undefined): Signal<string> | null {
  if (subtitle === undefined) {
    return null;
  }
  return isSignal(subtitle) ? subtitle : signal(subtitle).asReadonly();
}

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

  constructor() {
    inject(OpenSheets).attach(() => this.closeAll());
  }

  open<R = unknown, D = unknown>(content: ComponentType<unknown>, options: SheetOptions<D>): DialogRef<R> {
    const presentation = this.breakpoints.isMatched(BREAKPOINTS.phone) ? 'sheet' : 'dialog';
    const isFull = options.size === 'full';
    const frame: SheetFrame = {
      title: options.title,
      titleId: `tc-sheet-title-${nextSheetId++}`,
      presentation,
      size: isFull ? 'full' : 'default',
      subtitle: subtitleOf(options.subtitle),
      subtitleId: `tc-sheet-subtitle-${nextSheetId++}`,
      headAction: options.headAction === true && presentation === 'sheet',
    };
    const position = this.overlay.position().global().centerHorizontally();
    // One footer slot per sheet, shared by the frame (which renders it) and the content (which fills it).
    const footer = new SheetFooterSlot();
    const closeGuard = new SheetCloseGuard();
    const dialogPanel = isFull
      ? ['tc-dialog-panel', 'tc-dialog-panel--full']
      : options.width === 'wide' || options.width === 'task'
        ? ['tc-dialog-panel', `tc-dialog-panel--${options.width}`]
        : 'tc-dialog-panel';
    const sheetPanel = isFull ? ['tc-sheet-panel', 'tc-sheet-panel--full'] : 'tc-sheet-panel';

    return this.dialog.open<R, D, unknown>(content, {
      data: options.data ?? null,
      role: options.role ?? 'dialog',
      ariaModal: true,
      ariaLabelledBy: frame.subtitle === null ? frame.titleId : `${frame.titleId} ${frame.subtitleId}`,
      ariaDescribedBy: options.describedBy ?? null,
      autoFocus: options.autoFocus ?? '.tc-sheet__title',
      restoreFocus: true,
      hasBackdrop: true,
      backdropClass: 'tc-scrim',
      panelClass: presentation === 'sheet' ? sheetPanel : dialogPanel,
      positionStrategy: presentation === 'sheet' ? position.bottom('0') : position.centerVertically(),
      scrollStrategy: new SheetScrollStrategy(this.scrollLocks),
      providers: [
        { provide: SheetFooterSlot, useValue: footer },
        { provide: SheetCloseGuard, useValue: closeGuard },
      ],
      container: {
        type: SheetContainer,
        providers: () => [
          { provide: SHEET_FRAME, useValue: frame },
          { provide: SheetFooterSlot, useValue: footer },
          { provide: SheetCloseGuard, useValue: closeGuard },
        ],
      },
    });
  }

  /** Whether any sheet or dialog is open: someone may be in the middle of something a reload would lose (#306). */
  hasOpen(): boolean {
    return this.dialog.openDialogs.length > 0;
  }

  /**
   * Closes every open sheet and dialog, top first, each with no result — also one whose action is still running.
   * For when the screens behind them are gone (an expired session, #367): a sheet left over the page would hide it.
   */
  closeAll(): void {
    this.dialog.closeAll();
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
