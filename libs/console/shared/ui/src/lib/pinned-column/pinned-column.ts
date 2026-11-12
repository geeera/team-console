import { DOCUMENT } from '@angular/common';
import { DestroyRef, Directive, ElementRef, afterNextRender, inject, signal } from '@angular/core';

/**
 * A column pinned beside the page (`position: sticky; top: 0`) that never runs past the bottom of the screen (#507).
 * Sized to the full screen, a pane that starts below a page header had its last rows and the end of its own scrollbar
 * under the screen edge until the page was scrolled. This sets `--tc-pinned-max-h` to the screen height minus
 * whatever of the page is still above the column, so the column ends at the screen's edge at any scroll position; the
 * host's stylesheet uses it as `max-height: var(--tc-pinned-max-h, 100dvh)`.
 *
 * ```html
 * <aside tcPinnedColumn class="pane">…</aside>
 * ```
 */
@Directive({
  selector: '[tcPinnedColumn]',
  host: { '[style.--tc-pinned-max-h.px]': 'maxHeight()' },
})
export class PinnedColumn {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly document = inject(DOCUMENT);

  protected readonly maxHeight = signal<number | null>(null);

  constructor() {
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      const view = this.document.defaultView;
      if (view === null) {
        return;
      }
      let frame: number | null = null;
      const schedule = (): void => {
        frame ??= view.requestAnimationFrame(() => {
          frame = null;
          this.measure();
        });
      };
      this.measure();
      view.addEventListener('scroll', schedule, { passive: true });
      view.addEventListener('resize', schedule, { passive: true });
      // Content above the column can grow without a scroll (a banner arriving): the column moves down with it.
      const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
      observer?.observe(this.document.body);
      destroyRef.onDestroy(() => {
        view.removeEventListener('scroll', schedule);
        view.removeEventListener('resize', schedule);
        observer?.disconnect();
        if (frame !== null) {
          view.cancelAnimationFrame(frame);
        }
      });
    });
  }

  private measure(): void {
    const screen = this.document.documentElement.clientHeight;
    const top = Math.max(0, this.host.nativeElement.getBoundingClientRect().top);
    // Floor: a fractional top must not leave the column half a pixel past the edge.
    this.maxHeight.set(Math.max(0, Math.floor(screen - top)));
  }
}
