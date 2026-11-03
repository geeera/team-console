/** How long a screen may take to load content tall enough for the saved position. */
export const SCROLL_RESTORE_WINDOW_MS = 5_000;

// Any of these anywhere on the page means the owner is scrolling or acting: the saved position no longer applies.
const OWNER_INPUT = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

export interface ScrollRestore {
  /** True while waiting for the content; scroll events until then are the browser clamping, not the owner. */
  isPending(): boolean;
  cancel(): void;
}

const DONE: ScrollRestore = { isPending: () => false, cancel: () => undefined };

/**
 * Puts `scroller` (the document's scrolling element, #274) back at `top`. A screen that renders its content after the first frame (the questions list loads it)
 * is too short at first, so the browser clamps the position; then this waits for the content to grow and applies
 * the position once it fits — until the owner touches the screen, the next navigation cancels it, or `windowMs`.
 */
export function restoreScroll(
  scroller: Element,
  content: HTMLElement,
  top: number,
  windowMs = SCROLL_RESTORE_WINDOW_MS,
): ScrollRestore {
  scroller.scrollTop = top;
  if (top <= 0 || scroller.scrollTop >= top) {
    return DONE;
  }
  let isPending = true;
  const fits = (): boolean => scroller.scrollHeight - scroller.clientHeight >= top;
  const page = content.ownerDocument;
  const stop = (): void => {
    if (!isPending) {
      return;
    }
    isPending = false;
    observer.disconnect();
    clearTimeout(timer);
    for (const type of OWNER_INPUT) {
      page.removeEventListener(type, stop);
    }
  };
  const observer = new MutationObserver(() => {
    if (fits()) {
      scroller.scrollTop = top;
      stop();
    }
  });
  const timer = setTimeout(stop, windowMs);
  observer.observe(content, { childList: true, subtree: true, characterData: true });
  for (const type of OWNER_INPUT) {
    page.addEventListener(type, stop, { passive: true });
  }
  return { isPending: () => isPending, cancel: stop };
}
