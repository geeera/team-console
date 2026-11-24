import { leave, LEAVE_FALLBACK_MS } from './leave';

function animationEnd(el: HTMLElement, target: EventTarget = el): void {
  const event = new Event('animationend', { bubbles: true });
  Object.defineProperty(event, 'target', { value: target });
  el.dispatchEvent(event);
}

describe('leave', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('adds the leave class and calls done once on animationend', () => {
    const el = document.createElement('div');
    const done = vi.fn();
    leave(el, done);
    expect(el.classList.contains('m-leave')).toBe(true);
    animationEnd(el);
    animationEnd(el);
    vi.advanceTimersByTime(LEAVE_FALLBACK_MS);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('ignores animations bubbling up from a child', () => {
    const el = document.createElement('div');
    const child = document.createElement('span');
    el.append(child);
    const done = vi.fn();
    leave(el, done);
    animationEnd(el, child);
    expect(done).not.toHaveBeenCalled();
  });

  it('falls back to a timeout when no animation runs', () => {
    const done = vi.fn();
    leave(document.createElement('div'), done);
    vi.advanceTimersByTime(LEAVE_FALLBACK_MS - 1);
    expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('runs done at once when cancelled, and only once', () => {
    const done = vi.fn();
    const cancel = leave(document.createElement('div'), done);
    cancel();
    vi.advanceTimersByTime(LEAVE_FALLBACK_MS);
    expect(done).toHaveBeenCalledTimes(1);
  });
});
