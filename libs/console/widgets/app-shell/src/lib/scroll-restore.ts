/** How long a screen may take to load content tall enough for the saved position. */
export const SCROLL_RESTORE_WINDOW_MS = 5_000;

// Any of these on `<main>` means the owner is scrolling or acting: the saved position no longer applies.
const OWNER_INPUT = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

export interface ScrollRestore {
  /** True while waiting for the content; scroll events until then are the browser clamping, not the owner. */
  isPending(): boolean;
  cancel(): void;
}

const DONE: ScrollRestore = { isPending: () => false, cancel: () => undefined };

/**
 * Puts `main` back at `top`. A screen that renders its content after the first frame (the questions list loads it)
 * is too short at first, so the browser clamps the position; then this waits for the content to grow and applies
 * the position once it fits — until the owner touches the screen, the next navigation cancels it, or `windowMs`.
 */
export function restoreScroll(
  main: HTMLElement,
  top: number,
  windowMs = SCROLL_RESTORE_WINDOW_MS,
): ScrollRestore {
  main.scrollTop = top;
  if (top <= 0 || main.scrollTop >= top) {
    return DONE;
  }
  let isPending = true;
  const fits = (): boolean => main.scrollHeight - main.clientHeight >= top;
  const stop = (): void => {
    if (!isPending) {
      return;
    }
    isPending = false;
    observer.disconnect();
    clearTimeout(timer);
    for (const type of OWNER_INPUT) {
      main.removeEventListener(type, stop);
    }
  };
  const observer = new MutationObserver(() => {
    if (fits()) {
      main.scrollTop = top;
      stop();
    }
  });
  const timer = setTimeout(stop, windowMs);
  observer.observe(main, { childList: true, subtree: true, characterData: true });
  for (const type of OWNER_INPUT) {
    main.addEventListener(type, stop, { passive: true });
  }
  return { isPending: () => isPending, cancel: stop };
}
