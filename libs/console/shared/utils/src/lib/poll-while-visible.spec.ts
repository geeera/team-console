import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pollWhileVisible } from './poll-while-visible';

describe('pollWhileVisible', () => {
  let visibility: DocumentVisibilityState;

  beforeEach(() => {
    vi.useFakeTimers();
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const setVisibility = (value: DocumentVisibilityState): void => {
    visibility = value;
    document.dispatchEvent(new Event('visibilitychange'));
  };

  it('runs at once, then after each delay the last run asked for', async () => {
    const tick = vi.fn(() => Promise.resolve());
    let delay = 100;
    const stop = pollWhileVisible(document, tick, () => delay);
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(tick).toHaveBeenCalledTimes(2);

    delay = 500;
    await vi.advanceTimersByTimeAsync(100);
    expect(tick).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(499);
    expect(tick).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(4);
    stop();
  });

  it('holds while the page is hidden and runs once when it comes back, however many events arrive', async () => {
    const tick = vi.fn(() => Promise.resolve());
    const stop = pollWhileVisible(document, tick, () => 100);
    await vi.advanceTimersByTimeAsync(0);

    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tick).toHaveBeenCalledTimes(1);

    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(2);
    stop();
  });

  it('schedules nothing after stop, even for a run that was in flight', async () => {
    let finish: () => void = () => undefined;
    const tick = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const stop = pollWhileVisible(document, tick, () => 100);
    stop();
    finish();
    await vi.advanceTimersByTimeAsync(1_000);
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tick).toHaveBeenCalledTimes(1);
  });
});
