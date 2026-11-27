import { PollTimer, type PollRates } from './poll-timer';

const RATES: PollRates = { visibleMs: 2_000, hiddenMs: 15_000, limitMs: 60_000 };

describe('PollTimer', () => {
  let visibility: DocumentVisibilityState = 'visible';

  beforeEach(() => {
    vi.useFakeTimers({ now: Date.parse('2026-11-27T10:00:00.000Z') });
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function setup(read: (isCurrent: () => boolean) => Promise<void> = async () => undefined) {
    const reads = vi.fn(read);
    const onError = vi.fn();
    const poll = new PollTimer(document, reads, onError);
    return { poll, reads, onError };
  }

  it('reads every visible interval, never before the first one', async () => {
    const { poll, reads } = setup();
    poll.start(RATES);
    expect(reads).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(RATES.visibleMs * 3);
    expect(reads).toHaveBeenCalledTimes(3);
    poll.dispose();
  });

  it('slows to the hidden interval and reads at once when the page is shown again', async () => {
    const { poll, reads } = setup();
    visibility = 'hidden';
    poll.start(RATES);
    await vi.advanceTimersByTimeAsync(RATES.hiddenMs - 1);
    expect(reads).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(reads).toHaveBeenCalledTimes(1);

    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toHaveBeenCalledTimes(2);
    poll.dispose();
  });

  it('reads at once when the network comes back', async () => {
    const { poll, reads } = setup();
    poll.start(RATES);
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toHaveBeenCalledTimes(1);
    poll.dispose();
  });

  it('holds every read, wake-ups included, until a 429 has waited out its time, and counts it as no miss', async () => {
    let refused = false;
    const { poll, reads } = setup(async () => {
      if (!refused) {
        refused = true;
        poll.missed();
        poll.rateLimited(30_000);
      }
    });
    poll.start(RATES);
    await vi.advanceTimersByTimeAsync(RATES.visibleMs);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(poll.failedPolls()).toBe(0);
    expect(poll.rateLimitedFor()).toBe(30);
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(reads).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(reads).toHaveBeenCalledTimes(2);
    poll.answered();
    expect(poll.rateLimitedFor()).toBeNull();
    poll.dispose();
  });

  it('gives up after the limit and then reads only on checkNow()', async () => {
    const { poll, reads } = setup();
    poll.start(RATES);
    await vi.advanceTimersByTimeAsync(RATES.limitMs ?? 0);
    expect(poll.gaveUp()).toBe(true);
    const before = reads.mock.calls.length;
    await vi.advanceTimersByTimeAsync(RATES.visibleMs * 10);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toHaveBeenCalledTimes(before);
    await poll.checkNow();
    expect(reads).toHaveBeenCalledTimes(before + 1);
    poll.dispose();
  });

  it('drops a late answer once stopped and schedules nothing after a stop from inside the read', async () => {
    let finish: () => void = () => undefined;
    const late: boolean[] = [];
    const { poll, reads } = setup(
      (isCurrent) =>
        new Promise<void>((resolve) => {
          finish = () => {
            late.push(isCurrent());
            resolve();
          };
        }),
    );
    poll.start(RATES);
    await vi.advanceTimersByTimeAsync(RATES.visibleMs);
    poll.stop();
    finish();
    await vi.advanceTimersByTimeAsync(RATES.visibleMs * 5);
    expect(late).toEqual([false]);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(poll.isActive).toBe(false);
  });

  it('joins a read already under way instead of starting a second', async () => {
    let finish: () => void = () => undefined;
    const { poll, reads } = setup(() => new Promise<void>((resolve) => (finish = resolve)));
    poll.start(RATES);
    const first = poll.checkNow();
    const second = poll.checkNow();
    expect(reads).toHaveBeenCalledTimes(1);
    finish();
    await Promise.all([first, second]);
    poll.dispose();
  });

  it('reports a read that throws, counts it as missed and keeps polling', async () => {
    const { poll, reads, onError } = setup(async () => {
      throw new Error('guard bug');
    });
    poll.start(RATES);
    await vi.advanceTimersByTimeAsync(RATES.visibleMs * 2);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(poll.failedPolls()).toBe(2);
    expect(reads).toHaveBeenCalledTimes(2);
    poll.dispose();
  });

  it('stops listening to the page once disposed', async () => {
    const { poll, reads } = setup();
    poll.start(RATES);
    poll.dispose();
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(RATES.visibleMs * 3);
    expect(reads).not.toHaveBeenCalled();
  });
});
