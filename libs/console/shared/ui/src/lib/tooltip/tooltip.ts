import { DOCUMENT } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  inject,
  input,
  signal,
} from '@angular/core';

export type TooltipPlacement = 'top' | 'start';

const FOCUSABLE = 'a[href], button, [tabindex]';

/**
 * A short, non-interactive label for a mark whose name is already in the accessible tree (visually hidden text in
 * the same link or button). It repeats that name for sighted mouse and keyboard users, so it is `aria-hidden`.
 * It shows while its parent element is hovered (devices with hover only: on the phone a tap belongs to the row)
 * and while the nearest focusable ancestor has keyboard focus. Esc hides it until the next hover or focus
 * (WCAG 1.4.13). The parent is the anchor: give it `position: relative`.
 *
 * ```html
 * <span class="tier"><tc-icon name="tier-heavy" /><tc-tooltip>Tier: heavy</tc-tooltip></span>
 * ```
 */
@Component({
  selector: 'tc-tooltip',
  template: '<ng-content />',
  styleUrl: './tooltip.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'tc-tooltip',
    'aria-hidden': 'true',
    '[class.tc-tooltip--start]': 'placement() === "start"',
    '[class.tc-tooltip--shown]': 'shown()',
  },
})
export class Tooltip {
  /** `top`: above the anchor, aligned to its end. `start`: beside it, for an anchor inside a clipping surface. */
  readonly placement = input<TooltipPlacement>('top');

  protected readonly shown = signal(false);
  private hovered = false;
  private focused = false;
  private dismissed = false;

  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const document = inject(DOCUMENT);
    const destroyRef = inject(DestroyRef);

    afterNextRender(() => {
      const anchor = host.parentElement;
      if (anchor === null) {
        return;
      }
      const focusTarget = anchor.closest<HTMLElement>(FOCUSABLE);
      const canHover = document.defaultView?.matchMedia('(hover: hover)').matches ?? false;

      const onPointerEnter = (event: PointerEvent): void => {
        if (!canHover || event.pointerType === 'touch') {
          return;
        }
        this.hovered = true;
        this.dismissed = false;
        this.sync();
      };
      const onPointerLeave = (): void => {
        this.hovered = false;
        this.sync();
      };
      const onFocusIn = (): void => {
        this.focused = focusTarget?.matches(':focus-visible') ?? false;
        this.dismissed = false;
        this.sync();
      };
      const onFocusOut = (): void => {
        this.focused = false;
        this.sync();
      };
      const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key === 'Escape' && this.shown()) {
          this.dismissed = true;
          this.sync();
        }
      };

      anchor.addEventListener('pointerenter', onPointerEnter);
      anchor.addEventListener('pointerleave', onPointerLeave);
      focusTarget?.addEventListener('focusin', onFocusIn);
      focusTarget?.addEventListener('focusout', onFocusOut);
      document.addEventListener('keydown', onKeyDown);
      destroyRef.onDestroy(() => {
        anchor.removeEventListener('pointerenter', onPointerEnter);
        anchor.removeEventListener('pointerleave', onPointerLeave);
        focusTarget?.removeEventListener('focusin', onFocusIn);
        focusTarget?.removeEventListener('focusout', onFocusOut);
        document.removeEventListener('keydown', onKeyDown);
      });
    });
  }

  private sync(): void {
    this.shown.set((this.hovered || this.focused) && !this.dismissed);
  }
}
