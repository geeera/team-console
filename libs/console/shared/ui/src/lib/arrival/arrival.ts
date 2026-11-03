/** The class `base.css` draws the arrival ring with; it stays while focus is inside the element. */
export const ARRIVAL_CLASS = 'tc-arrival';

export interface Arrival {
  /** Takes the ring off now (a newer arrival, the screen going away). */
  clear(): void;
}

/** `<html data-motion>` forces a choice (the Storybook toolbar, a later setting); otherwise the OS decides. */
export function prefersReducedMotion(document: Document): boolean {
  const forced = document.documentElement.getAttribute('data-motion');
  if (forced === 'reduce' || forced === 'full') {
    return forced === 'reduce';
  }
  return document.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/**
 * "You came here": brings `element` into view, rings it, and moves focus to `focusTarget` (the element itself by
 * default; it must be focusable, e.g. `tabindex="-1"`). The ring swells once and then stays while focus is inside,
 * so the place is still marked after the motion; it goes when focus leaves. With reduced motion the scroll jumps
 * and the ring simply appears.
 */
export function markArrival(element: HTMLElement, focusTarget: HTMLElement = element): Arrival {
  const document = element.ownerDocument;
  // Missing only outside a browser (jsdom); the ring and the focus still apply there.
  if (typeof element.scrollIntoView === 'function') {
    element.scrollIntoView({ block: 'center', behavior: prefersReducedMotion(document) ? 'auto' : 'smooth' });
  }
  element.classList.add(ARRIVAL_CLASS);
  focusTarget.focus({ preventScroll: true });

  const clear = (): void => {
    element.classList.remove(ARRIVAL_CLASS);
    element.removeEventListener('focusout', onFocusOut);
  };
  const onFocusOut = (event: FocusEvent): void => {
    const next = event.relatedTarget;
    if (!(next instanceof Node) || !element.contains(next)) {
      clear();
    }
  };
  element.addEventListener('focusout', onFocusOut);
  return { clear };
}
