import { signal } from '@angular/core';

/** How often a poll reads, and for how long it reads on its own. */
export interface PollRates {
  readonly visibleMs: number;
  readonly hiddenMs: number;
  /** After this long only `checkNow()` reads (`gaveUp` turns true); `null` polls until stopped. */
  readonly limitMs: number | null;
}

/** One read. `isCurrent()` turns false once the poll is stopped or restarted, so a late answer is dropped. */
export type PollRead = (isCurrent: () => boolean) => Promise<void>;

/**
 * The timers of an owner-facing poll (#634 PR 4, #1059 PR 3), shared by `EnrolmentWatch` and `RunnerCheckWatch`:
 * a read every `visibleMs` while the page is visible and every `hiddenMs` while it is hidden, one at once when the
 * page is shown again or the network comes back, none before a 429's `Retry-After` has passed (wake-ups included),
 * and no timed read after `limitMs`. It knows nothing of what is read: the watch decides when a read is done
 * (`stop()`), answered (`answered()`), refused for now (`rateLimited()`) or missed (`missed()`).
 */
export class PollTimer {
  readonly gaveUp = signal(false);
  /** Reads in a row that got no usable answer; a 429 is an answer and resets it. */
  readonly failedPolls = signal(0);
  /** Seconds the last 429 asked to wait; `null` once a read succeeds again. */
  readonly rateLimitedFor = signal<number | null>(null);

  private rates: PollRates | null = null;
  /** Bumped by every start and stop, so an answer to an older read is dropped. */
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private limitTimer: ReturnType<typeof setTimeout> | null = null;
  /** No read before this (`Date.now()`). It survives a restart: the limit is the caller's, not the target's. */
  private heldUntil = 0;
  private inFlight: Promise<void> | null = null;
  private readonly wake = (): void => {
    if (this.document.visibilityState !== 'hidden' && !this.gaveUp() && Date.now() >= this.heldUntil) {
      void this.checkNow();
    }
  };

  constructor(
    private readonly document: Document,
    private readonly read: PollRead,
    /** A read that threw (a bug, never a refusal): reported here, and the poll goes on. */
    private readonly onError: (error: unknown) => void,
  ) {
    document.addEventListener('visibilitychange', this.wake);
    document.defaultView?.addEventListener('online', this.wake);
  }

  get isActive(): boolean {
    return this.rates !== null;
  }

  /** Starts over at these rates: the first read is one interval away. */
  start(rates: PollRates): void {
    this.reset();
    this.rates = rates;
    if (rates.limitMs !== null) {
      this.limitTimer = setTimeout(() => this.giveUp(), rates.limitMs);
    }
    this.schedule();
  }

  stop(): void {
    this.reset();
    this.rates = null;
  }

  /** Removes the page listeners; the owner calls it once, on destroy. */
  dispose(): void {
    this.stop();
    this.document.removeEventListener('visibilitychange', this.wake);
    this.document.defaultView?.removeEventListener('online', this.wake);
  }

  /** One read now, whatever the timer says; joins a read already under way. */
  checkNow(): Promise<void> {
    if (this.rates === null) {
      return Promise.resolve();
    }
    if (this.inFlight !== null) {
      return this.inFlight;
    }
    this.clearTimer();
    const run: Promise<void> = this.tick().finally(() => {
      if (this.inFlight === run) {
        this.inFlight = null;
      }
    });
    this.inFlight = run;
    return run;
  }

  answered(): void {
    this.failedPolls.set(0);
    this.rateLimitedFor.set(null);
  }

  /** A 429: the console answered, so this is not "no connection", and reading sooner would only be refused again. */
  rateLimited(waitMs: number): void {
    this.heldUntil = Date.now() + waitMs;
    this.failedPolls.set(0);
    this.rateLimitedFor.set(Math.ceil(waitMs / 1000));
  }

  missed(): void {
    this.failedPolls.update((count) => count + 1);
  }

  private async tick(): Promise<void> {
    const generation = this.generation;
    const isCurrent = (): boolean => generation === this.generation;
    try {
      await this.read(isCurrent);
    } catch (error: unknown) {
      // A bug in a guard or a signal must not end the polling silently.
      this.onError(error);
      if (isCurrent()) {
        this.missed();
      }
    }
    if (isCurrent()) {
      this.schedule();
    }
  }

  private schedule(): void {
    this.clearTimer();
    if (this.rates === null || this.gaveUp()) {
      return;
    }
    const interval = this.document.visibilityState === 'hidden' ? this.rates.hiddenMs : this.rates.visibleMs;
    this.timer = setTimeout(() => void this.checkNow(), Math.max(interval, this.heldUntil - Date.now()));
  }

  private giveUp(): void {
    this.limitTimer = null;
    this.clearTimer();
    this.gaveUp.set(true);
  }

  private reset(): void {
    this.generation += 1;
    this.inFlight = null;
    this.clearTimer();
    if (this.limitTimer !== null) {
      clearTimeout(this.limitTimer);
      this.limitTimer = null;
    }
    this.gaveUp.set(false);
    this.failedPolls.set(0);
    this.rateLimitedFor.set(null);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
