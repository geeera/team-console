import { Injectable } from '@angular/core';

/**
 * Lets a sheet's content decide what closing means (#634 PR 4: the add-runner wizard asks before it withdraws a live
 * request). One per opened sheet, injected by its content. While a handler is set, the close button, Escape and the
 * scrim call it instead of closing; the content sets `DialogRef.disableClose` so the CDK leaves Escape and the scrim
 * to the frame, and closes the ref itself when it is ready.
 */
@Injectable()
export class SheetCloseGuard {
  private handler: (() => void) | null = null;

  intercept(handler: () => void): void {
    this.handler = handler;
  }

  release(): void {
    this.handler = null;
  }

  /** `true` when a handler took the request, so the frame must not close on its own. */
  request(): boolean {
    if (this.handler === null) {
      return false;
    }
    this.handler();
    return true;
  }
}
