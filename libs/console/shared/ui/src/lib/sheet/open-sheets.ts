import { Injectable } from '@angular/core';

/**
 * Closes every open sheet without importing `Sheet` (#337): the app root reaches this eagerly, and a static `Sheet`
 * there pulls the frame and the CDK dialog back into the initial bundle that #123 made lazy. `Sheet` attaches itself
 * when it is first created; until then nothing can be open, so `closeAll()` has nothing to do.
 */
@Injectable({ providedIn: 'root' })
export class OpenSheets {
  private closer: (() => void) | null = null;

  /** Called by `Sheet` only. */
  attach(closeAll: () => void): void {
    this.closer = closeAll;
  }

  /**
   * Closes every open sheet and dialog, top first, each with no result — also one whose action is still running.
   * For when the screens behind them are gone (an expired session, #367): a sheet left over the page would hide it.
   */
  closeAll(): void {
    this.closer?.();
  }
}
