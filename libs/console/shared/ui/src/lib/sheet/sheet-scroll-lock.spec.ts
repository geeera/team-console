import {
  COVERED_PANE_CLASS,
  isPageScrollLocked,
  SCROLL_LOCK_ATTRIBUTE,
  SheetScrollLocks,
} from './sheet-scroll-lock';

describe('SheetScrollLocks', () => {
  const pane = (): HTMLElement => document.createElement('div');
  // jsdom has no scrolling: the window's offsets and scrollTo are stood in for.
  let scrollTo: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
    Object.defineProperty(window, 'scrollX', { value: 0, configurable: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute('style');
  });

  it('pins the document whatever its height, and puts it back where it was when the last pane closes', () => {
    const root = document.documentElement;
    root.style.width = '50%';
    Object.defineProperty(window, 'scrollY', { value: 420, configurable: true });
    const locks = new SheetScrollLocks(root);
    const [first, second] = [pane(), pane()];

    // jsdom lays nothing out, so the page is "shorter than the screen": the CDK's block would not lock it.
    locks.lock(first);
    expect(root.style.position).toBe('fixed');
    expect(root.style.top).toBe('-420px');
    expect(root.style.width).toBe('100%');

    locks.lock(second);
    locks.unlock(second);
    expect(root.style.position).toBe('fixed');
    expect(scrollTo).not.toHaveBeenCalled();

    locks.unlock(first);
    expect(root.style.position).toBe('');
    expect(root.style.top).toBe('');
    expect(root.style.width).toBe('50%');
    expect(scrollTo).toHaveBeenCalledWith({ top: 420, left: 0, behavior: 'instant' });
  });

  it('marks the root while any pane is locked and clears it after the last one', () => {
    const root = document.createElement('html');
    const locks = new SheetScrollLocks(root);
    const first = pane();
    const second = pane();

    locks.lock(first);
    locks.lock(second);
    expect(root.hasAttribute(SCROLL_LOCK_ATTRIBUTE)).toBe(true);

    locks.unlock(first);
    expect(root.hasAttribute(SCROLL_LOCK_ATTRIBUTE)).toBe(true);
    locks.unlock(second);
    expect(root.hasAttribute(SCROLL_LOCK_ATTRIBUTE)).toBe(false);
  });

  it('covers every pane but the newest, and uncovers the next one when the top closes', () => {
    const locks = new SheetScrollLocks(document.createElement('html'));
    const [a, b, c] = [pane(), pane(), pane()];
    locks.lock(a);
    locks.lock(b);
    locks.lock(c);
    expect([a, b, c].map((p) => p.classList.contains(COVERED_PANE_CLASS))).toEqual([true, true, false]);

    locks.unlock(c);
    expect([a, b, c].map((p) => p.classList.contains(COVERED_PANE_CLASS))).toEqual([true, false, false]);
  });

  it('ignores a repeated lock and an unlock of a pane it never locked', () => {
    const root = document.createElement('html');
    const locks = new SheetScrollLocks(root);
    const a = pane();
    locks.lock(a);
    locks.lock(a);
    locks.unlock(pane());
    expect(a.classList.contains(COVERED_PANE_CLASS)).toBe(false);
    locks.unlock(a);
    expect(root.hasAttribute(SCROLL_LOCK_ATTRIBUTE)).toBe(false);
  });

  it('reports the lock on the document while a pane holds it', () => {
    const locks = new SheetScrollLocks(document.documentElement);
    const a = pane();
    expect(isPageScrollLocked(document)).toBe(false);
    locks.lock(a);
    expect(isPageScrollLocked(document)).toBe(true);
    locks.unlock(a);
    expect(isPageScrollLocked(document)).toBe(false);
  });
});
