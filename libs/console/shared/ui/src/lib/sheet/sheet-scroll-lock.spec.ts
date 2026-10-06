import { COVERED_PANE_CLASS, SCROLL_LOCK_ATTRIBUTE, SheetScrollLocks } from './sheet-scroll-lock';

describe('SheetScrollLocks', () => {
  const pane = (): HTMLElement => document.createElement('div');

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
});
