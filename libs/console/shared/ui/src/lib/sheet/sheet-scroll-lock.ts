import type { OverlayRef, ScrollStrategy } from '@angular/cdk/overlay';

/**
 * Set on the root element while any sheet or dialog is open: the document is pinned then, and `overlay.css` stops
 * every `.tc-page-scroll` column.
 */
export const SCROLL_LOCK_ATTRIBUTE = 'data-tc-scroll-lock';
/**
 * Whether a sheet or dialog holds the page still. While it does, the document's scroll position is the lock's
 * (`<html>` is pinned and reads 0), not the owner's: a screen that remembers its position must not record it.
 */
export function isPageScrollLocked(document: Document): boolean {
  return document.documentElement.hasAttribute(SCROLL_LOCK_ATTRIBUTE);
}

/** Set on the pane of every open sheet but the top one, so only the top body scrolls. */
export const COVERED_PANE_CLASS = 'tc-overlay-covered';

/** What pinning changed on `<html>`, to put back on release. */
interface PinnedDocument {
  readonly top: number;
  readonly left: number;
  readonly style: Readonly<Record<'position' | 'top' | 'left' | 'width' | 'overflowY', string>>;
}

/**
 * The open sheets, oldest first, for one document (#274). While any is open the document is pinned in place, the
 * columns that scroll beside it (`.tc-page-scroll`: the sidebar, the Commands pane) stop, and every sheet under the
 * top one stops, so only the top body scrolls.
 *
 * The document is pinned here, not by the CDK's block strategy: that one locks only a page that is already taller
 * than the screen when the sheet opens, so a page whose data arrived afterwards scrolled behind the sheet (#281 QA).
 * Pinning is the CDK's technique — `position: fixed` at the negative scroll offset, which iOS Safari honours where
 * `overflow: hidden` on the root does not — applied always, and the position is restored on release.
 */
export class SheetScrollLocks {
  private readonly panes: HTMLElement[] = [];
  private pinned: PinnedDocument | null = null;

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
    if (this.panes.length > 0) {
      this.pin();
    } else {
      this.release();
    }
    this.root.toggleAttribute(SCROLL_LOCK_ATTRIBUTE, this.panes.length > 0);
  }

  private pin(): void {
    const view = this.root.ownerDocument.defaultView;
    if (this.pinned !== null || view === null) {
      return;
    }
    const style = this.root.style;
    const top = view.scrollY;
    const left = view.scrollX;
    // A page that showed a scrollbar keeps its track, so nothing under the scrim shifts sideways.
    const hasScrollbar = this.root.scrollHeight > this.root.clientHeight;
    this.pinned = {
      top,
      left,
      style: {
        position: style.position,
        top: style.top,
        left: style.left,
        width: style.width,
        overflowY: style.overflowY,
      },
    };
    style.position = 'fixed';
    style.top = `${-top}px`;
    style.left = `${-left}px`;
    style.width = '100%';
    if (hasScrollbar) {
      style.overflowY = 'scroll';
    }
  }

  private release(): void {
    const view = this.root.ownerDocument.defaultView;
    const pinned = this.pinned;
    if (pinned === null || view === null) {
      return;
    }
    this.pinned = null;
    Object.assign(this.root.style, pinned.style);
    view.scrollTo({ top: pinned.top, left: pinned.left, behavior: 'instant' });
  }
}

/** One per opened sheet: registers its pane with the document's locks while it is open. */
export class SheetScrollStrategy implements ScrollStrategy {
  private pane: HTMLElement | null = null;

  constructor(private readonly locks: SheetScrollLocks) {}

  attach(overlayRef: OverlayRef): void {
    this.pane = overlayRef.overlayElement;
  }

  enable(): void {
    if (this.pane !== null) {
      this.locks.lock(this.pane);
    }
  }

  disable(): void {
    if (this.pane !== null) {
      this.locks.unlock(this.pane);
    }
  }

  detach(): void {
    this.disable();
    this.pane = null;
  }
}
