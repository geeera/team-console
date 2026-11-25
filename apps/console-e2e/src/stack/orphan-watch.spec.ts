import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onOrphaned, stopWithin } from './orphan-watch.mts';

describe('onOrphaned', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does nothing while the parent is the one that started the process', () => {
    const stop = vi.fn();
    const cancel = onOrphaned(stop, { parentPid: 4242, currentParentPid: () => 4242, intervalMs: 100 });

    vi.advanceTimersByTime(1_000);

    expect(stop).not.toHaveBeenCalled();
    cancel();
  });

  it('stops once when the parent is gone and the system re-parented the process', () => {
    let parent = 4242;
    const stop = vi.fn();
    onOrphaned(stop, { parentPid: 4242, currentParentPid: () => parent, intervalMs: 100 });

    vi.advanceTimersByTime(250);
    parent = 1;
    vi.advanceTimersByTime(1_000);

    expect(stop).toHaveBeenCalledExactlyOnceWith();
  });

  it('takes the parent at the time of the call when none is given', () => {
    let parent = 777;
    const stop = vi.fn();
    onOrphaned(stop, { currentParentPid: () => parent, intervalMs: 100 });

    vi.advanceTimersByTime(100);
    expect(stop).not.toHaveBeenCalled();
    parent = 1;
    vi.advanceTimersByTime(100);

    expect(stop).toHaveBeenCalledOnce();
  });

  it('stops watching when cancelled', () => {
    let parent = 4242;
    const stop = vi.fn();
    const cancel = onOrphaned(stop, { parentPid: 4242, currentParentPid: () => parent, intervalMs: 100 });

    cancel();
    parent = 1;
    vi.advanceTimersByTime(1_000);

    expect(stop).not.toHaveBeenCalled();
  });
});

describe('stopWithin', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers stopped when the stop settles in time, and leaves no timer behind', async () => {
    expect(await stopWithin(() => Promise.resolve(), 5_000)).toEqual({ kind: 'stopped' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('answers the failure of a stop that rejects instead of throwing it', async () => {
    const error = new Error('workerd refused');

    expect(await stopWithin(() => Promise.reject(error), 5_000)).toEqual({ kind: 'failed', error });
  });

  it('answers timed-out at the deadline when the stop never settles', async () => {
    const outcome = stopWithin(() => new Promise<void>(() => undefined), 5_000);
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(await outcome).toEqual({ kind: 'timed-out', afterMs: 5_000 });
  });
});
