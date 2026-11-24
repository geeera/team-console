/** A debounced function: calling it schedules `fn`, but resets the delay on every new call. */
export interface Debounced<Args extends readonly unknown[]> {
  (...args: Args): void;
  /** Drops a pending call without running it; safe to call when none is pending. */
  readonly cancel: () => void;
}

/**
 * Wraps `fn` so a call runs only once `delayMs` has passed without another one — the standard pattern behind a
 * search box or a live-region announcement that should not fire on every keystroke. `cancel()` belongs in the
 * caller's teardown (e.g. `DestroyRef.onDestroy`), since a pending timer otherwise outlives it.
 */
export function debounce<Args extends readonly unknown[]>(
  fn: (...args: Args) => void,
  delayMs: number,
): Debounced<Args> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const debounced = (...args: Args): void => {
    cancel();
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, delayMs);
  };
  return Object.assign(debounced, { cancel });
}
