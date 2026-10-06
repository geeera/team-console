import type { OverlayRef, ScrollStrategy } from '@angular/cdk/overlay';

/** Set on the root element while any sheet or dialog is open; `overlay.css` stops every `.tc-page-scroll` then. */
export const SCROLL_LOCK_ATTRIBUTE = 'data-tc-scroll-lock';
/**
 * Whether a sheet or dialog holds the page still. While it does, the document's scroll position is the lock's (the
 * CDK pins `<html>` and resets it), not the owner's: a screen that remembers its position must not record it.
 */
export function isPageScrollLocked(document: Document): boolean {
  return document.documentElement.hasAttribute(SCROLL_LOCK_ATTRIBUTE);
}

/** Set on the pane of every open sheet but the top one, so only the top body scrolls. */
export const COVERED_PANE_CLASS = 'tc-overlay-covered';

/**
 * The open sheets, oldest first, for one document. The CDK's block strategy pins the document; this also stops the
 * columns that scroll beside it (`.tc-page-scroll`: the sidebar, the Commands pane) and every sheet under the top
 * one, so only the top body scrolls (#274).
 */
export class SheetScrollLocks {
  private readonly panes: HTMLElement[] = [];

  constructor(private readonly root: HTMLElement) {}

  lock(pane: HTMLElement): void {
    if (!this.panes.includes(pane)) {
      this.panes.push(pane);
    }
    this.sync();
  }

  unlock(pane: HTMLElement): void {
    const index = this.panes.indexOf(pane);
    if (index !== -1) {
      this.panes.splice(index, 1);
    }
    pane.classList.remove(COVERED_PANE_CLASS);
    this.sync();
  }

  private sync(): void {
    const top = this.panes.length - 1;
    this.panes.forEach((pane, index) => pane.classList.toggle(COVERED_PANE_CLASS, index !== top));
    this.root.toggleAttribute(SCROLL_LOCK_ATTRIBUTE, this.panes.length > 0);
  }
}

/** One per opened sheet: the CDK's document block plus the console's page and stacked-sheet locks. */
export class SheetScrollStrategy implements ScrollStrategy {
  private pane: HTMLElement | null = null;

  constructor(
    private readonly locks: SheetScrollLocks,
    private readonly documentBlock: ScrollStrategy,
  ) {}

  attach(overlayRef: OverlayRef): void {
    this.pane = overlayRef.overlayElement;
    this.documentBlock.attach(overlayRef);
  }

  enable(): void {
    this.documentBlock.enable();
    if (this.pane !== null) {
      this.locks.lock(this.pane);
    }
  }

  disable(): void {
    if (this.pane !== null) {
      this.locks.unlock(this.pane);
    }
    this.documentBlock.disable();
  }

  detach(): void {
    this.disable();
    this.documentBlock.detach?.();
    this.pane = null;
  }
}
