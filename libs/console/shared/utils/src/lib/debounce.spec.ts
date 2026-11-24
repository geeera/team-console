import { describe, expect, it, vi } from 'vitest';
import { debounce } from './debounce';

describe('debounce', () => {
  it('fires once after the delay', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 250);

    debounced('a');
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(249);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith('a');

    vi.useRealTimers();
  });

  it('resets the timer on a new call, running only with the latest arguments', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 250);

    debounced('a');
    vi.advanceTimersByTime(200);
    debounced('b');
    vi.advanceTimersByTime(200);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith('b');

    vi.useRealTimers();
  });

  it('cancel drops a pending call', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 250);

    debounced('a');
    debounced.cancel();
    vi.advanceTimersByTime(250);
    expect(fn).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('cancel without a pending call is a no-op', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 250);

    expect(() => debounced.cancel()).not.toThrow();
    vi.advanceTimersByTime(250);
    expect(fn).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});
