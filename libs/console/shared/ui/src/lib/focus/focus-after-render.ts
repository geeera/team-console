import { afterNextRender, ElementRef, Injector } from '@angular/core';
import { Sheet } from '../sheet/sheet';

/**
 * Moves focus to `target` after the next render, but skips the move while a sheet or dialog is open (#514, #518):
 * an async load (a status check, a connection refresh) that finishes while the owner is in the middle of something
 * in a sheet must not pull focus out from under it. Call from a constructor or any method that already has an
 * `Injector` (the component's own, from `inject(Injector)`), the same way `afterNextRender` itself is called
 * outside a constructor.
 */
export function focusAfterRender(
  target: () => ElementRef<HTMLElement> | null | undefined,
  options: { injector: Injector },
): void {
  const sheet = options.injector.get(Sheet);
  afterNextRender(
    () => {
      if (!sheet.hasOpen()) {
        target()?.nativeElement.focus();
      }
    },
    { injector: options.injector },
  );
}
