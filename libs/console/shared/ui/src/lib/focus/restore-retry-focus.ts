import { ElementRef, inject, Injector } from '@angular/core';
import { focusAfterRender } from './focus-after-render';

// Matches the action button of an error `tc-state-block`, not a link such as the project-setup one.
const RETRY_SELECTOR = '.tc-state-block--error button[tc-state-action]';

/**
 * Returns a function that puts focus back after a Retry (#135, #862). Clicking Retry swaps the error block for a
 * loading one, so focus falls to `<body>`; once the load has settled, call the returned function to move it to the
 * new Retry button or, when the load succeeded, to `fallback` (usually the view's heading). Focus the owner has
 * moved elsewhere in the meantime is left alone.
 *
 * Call from an injection context (a field initializer): it captures the component's host and injector.
 *
 * ```ts
 * private readonly restoreRetryFocus = injectRetryFocus(() => this.heading());
 * protected async reload(): Promise<void> {
 *   await this.store.load();
 *   this.restoreRetryFocus();
 * }
 * ```
 */
export function injectRetryFocus(
  fallback: () => ElementRef<HTMLElement> | null | undefined = () => null,
): () => void {
  const host = inject<ElementRef<HTMLElement>>(ElementRef);
  const injector = inject(Injector);
  return () =>
    focusAfterRender(
      () => {
        const retry = host.nativeElement.querySelector<HTMLElement>(RETRY_SELECTOR);
        return retry === null ? fallback() : new ElementRef(retry);
      },
      { injector, onlyIfFocusLost: true },
    );
}
