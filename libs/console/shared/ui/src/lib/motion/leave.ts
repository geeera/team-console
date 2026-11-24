/** Longest a leave animation may take before the element is removed anyway (the exit is at most --dur-slow). */
export const LEAVE_FALLBACK_MS = 500;

/**
 * Plays the exit on an element that is already closed and then calls `done` once: on `animationend`, or after a
 * timeout when no animation runs (reduced motion, `display: none`, a detached node). Nothing waits for it: the
 * caller has already moved focus and updated its state.
 *
 * Returns a cancel function for the next navigation; it runs `done` at once.
 */
export function leave(el: HTMLElement, done: () => void, className = 'm-leave'): () => void {
  let isDone = false;
  const finish = (): void => {
    if (isDone) {
      return;
    }
    isDone = true;
    clearTimeout(timer);
    el.removeEventListener('animationend', onEnd);
    done();
  };
  const onEnd = (event: AnimationEvent): void => {
    // A child's animation bubbles up; only the element's own end counts.
    if (event.target === el) {
      finish();
    }
  };
  const timer = setTimeout(finish, LEAVE_FALLBACK_MS);
  el.addEventListener('animationend', onEnd);
  el.classList.add(className);
  return finish;
}
