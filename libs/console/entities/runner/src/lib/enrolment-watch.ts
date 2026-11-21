import { DOCUMENT } from '@angular/common';
import { DestroyRef, ErrorHandler, inject, Injectable, signal } from '@angular/core';
import type { EnrolmentIntentDto, EnrolmentIntentState, RunnerDto } from '@shared/contracts';
import type { RunnerFailure } from './runner-failure';
import { RunnersApi } from './runners.api';

/**
 * Poll rates of the add-runner wizard (#634 PR 4, UX spec §2). One open sheet costs at most 200 reads in the
 * intent's ten minutes (20 a minute), well inside the per-user limit on account GETs (#879: 120 a minute, 429 with
 * `Retry-After`); on a 429 the watch waits out `Retry-After` before it reads again. `ENROLMENT_INTENT_POLL_SECONDS`
 * is the runner door's rate, not this one.
 */
export const INTENT_POLL_VISIBLE_MS = 3_000;
export const RUNNER_POLL_VISIBLE_MS = 5_000;
export const POLL_HIDDEN_MS = 15_000;
/**
 * How long the runner is polled after the approval before the watch gives up (#878): three times the five-minute
 * "not online yet" threshold (owner decision 4), so at most 180 reads; a re-check is one read on the owner's click.
 */
export const RUNNER_WATCH_LIMIT_MS = 15 * 60_000;
/** Failed polls in a row before the wizard says the console is unreachable (spec §6 state 16). */
export const POLL_FAILURES_SHOWN = 2;
/** The wait after a 429 that named no `Retry-After`. */
export const RATE_LIMITED_DEFAULT_MS = 60_000;
/** A local expiry is confirmed by the server a moment later: its clock, not ours, decides. */
const EXPIRY_GRACE_MS = 500;

/** States after which the intent never changes again, so polling it stops. */
const SETTLED: ReadonlySet<EnrolmentIntentState> = new Set(['approved', 'used', 'expired', 'withdrawn']);

/** Why a watch stopped on its own: the session ended, the caller lost the owner role, or the intent is not theirs. */
export type EnrolmentWatchStop = 'session-expired' | 'forbidden' | 'not-found';

type Target =
  | { readonly kind: 'intent'; readonly accountId: string; readonly intentId: string }
  | { readonly kind: 'runner'; readonly accountId: string; readonly runnerId: string };

/**
 * The add-runner wizard's polling model (#634 PR 4): an intent until it settles, then the runner it created until it
 * is online. Every 3 s (intent) or 5 s (runner) while the page is visible, every 15 s while it is hidden, and once at
 * once when the page becomes visible again or the network comes back. The runner is polled for
 * `RUNNER_WATCH_LIMIT_MS` at most; after that only `checkNow()` reads (#878). One watch per wizard: provide it in the
 * component, so closing the sheet stops every timer. The intent id is only ever in the path of the owner's own GET.
 */
@Injectable()
export class EnrolmentWatch {
  private readonly api = inject(RunnersApi);
  private readonly document = inject(DOCUMENT);
  private readonly errors = inject(ErrorHandler);

  readonly intent = signal<EnrolmentIntentDto | null>(null);
  readonly runner = signal<RunnerDto | null>(null);
  readonly minimumVersion = signal<string | null>(null);
  readonly failedPolls = signal(0);
  readonly stopped = signal<EnrolmentWatchStop | null>(null);
  /** The runner poll ran out its `RUNNER_WATCH_LIMIT_MS`: nothing polls until `checkNow()` (the owner's re-check). */
  readonly gaveUp = signal(false);
  /** Seconds the last 429 asked the watch to wait (#879); `null` once a read succeeds again. */
  readonly rateLimitedFor = signal<number | null>(null);

  private target: Target | null = null;
  /** Bumped by every new target or stop, so an answer to an older read is dropped. */
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private limitTimer: ReturnType<typeof setTimeout> | null = null;
  /** No read before this (`Date.now()`), so a wake-up does not hit the limit again. */
  private heldUntil = 0;
  private inFlight: Promise<void> | null = null;

  constructor() {
    const view = this.document.defaultView;
    const wake = (): void => {
      if (this.document.visibilityState !== 'hidden' && !this.gaveUp() && Date.now() >= this.heldUntil) {
        void this.checkNow();
      }
    };
    this.document.addEventListener('visibilitychange', wake);
    view?.addEventListener('online', wake);
    inject(DestroyRef).onDestroy(() => {
      this.stop();
      this.document.removeEventListener('visibilitychange', wake);
      view?.removeEventListener('online', wake);
    });
  }

  /** Watches a fresh intent; `expiresAt` arms the one confirming read at local expiry. */
  watchIntent(accountId: string, intentId: string, expiresAt: string): void {
    this.retarget({ kind: 'intent', accountId, intentId });
    this.intent.set(null);
    this.armExpiry(expiresAt);
    this.schedule();
  }

  /** Watches the runner an approval created until `GET …/runners` shows it online, for `RUNNER_WATCH_LIMIT_MS`. */
  watchRunner(accountId: string, runnerId: string): void {
    this.retarget({ kind: 'runner', accountId, runnerId });
    this.runner.set(null);
    this.limitTimer = setTimeout(() => this.giveUp(), RUNNER_WATCH_LIMIT_MS);
    this.schedule();
  }

  stop(): void {
    this.retarget(null);
  }

  /** One read now, whatever the timer says; joins a read already under way. */
  checkNow(): Promise<void> {
    if (this.target === null) {
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

  private async tick(): Promise<void> {
    const target = this.target;
    const generation = this.generation;
    if (target === null) {
      return;
    }
    try {
      await this.read(target, generation);
    } catch (error: unknown) {
      // RunnersApi never throws by contract; a bug in a guard or a signal must not end the polling silently.
      this.errors.handleError(error);
      if (generation === this.generation) {
        this.failedPolls.update((count) => count + 1);
      }
    }
    if (generation === this.generation) {
      this.schedule();
    }
  }

  private async read(target: Target, generation: number): Promise<void> {
    if (target.kind === 'intent') {
      const read = await this.api.enrolmentIntent(target.accountId, target.intentId);
      if (generation !== this.generation) {
        return;
      }
      if (read.ok) {
        this.answered();
        this.intent.set(read.value);
        if (SETTLED.has(read.value.state)) {
          this.retarget(null);
        } else {
          this.armExpiry(read.value.expiresAt);
        }
      } else {
        this.fail(read.failure);
      }
    } else {
      const read = await this.api.list(target.accountId);
      if (generation !== this.generation) {
        return;
      }
      if (read.ok) {
        this.answered();
        const runner = read.value.runners.find((row) => row.id === target.runnerId) ?? null;
        this.runner.set(runner);
        this.minimumVersion.set(read.value.release.minimumVersion);
        if (runner?.online === true) {
          this.retarget(null);
        }
      } else {
        this.fail(read.failure);
      }
    }
  }

  private giveUp(): void {
    this.limitTimer = null;
    this.clearTimer();
    this.gaveUp.set(true);
  }

  private answered(): void {
    this.failedPolls.set(0);
    this.rateLimitedFor.set(null);
  }

  private fail(failure: RunnerFailure): void {
    switch (failure.kind) {
      case 'rate-limited': {
        // The console answered: this is not "no connection", and polling sooner would only be refused again.
        const seconds = failure.retryAfterSeconds ?? null;
        const waitMs = seconds === null ? RATE_LIMITED_DEFAULT_MS : seconds * 1000;
        this.heldUntil = Date.now() + waitMs;
        this.failedPolls.set(0);
        this.rateLimitedFor.set(Math.ceil(waitMs / 1000));
        return;
      }
      case 'session-expired':
      case 'forbidden':
      case 'not-found':
        this.retarget(null);
        this.stopped.set(failure.kind);
        return;
      default:
        this.failedPolls.update((count) => count + 1);
    }
  }

  private schedule(): void {
    this.clearTimer();
    if (this.target === null || this.gaveUp()) {
      return;
    }
    const visible = this.target.kind === 'intent' ? INTENT_POLL_VISIBLE_MS : RUNNER_POLL_VISIBLE_MS;
    const interval = this.document.visibilityState === 'hidden' ? POLL_HIDDEN_MS : visible;
    this.timer = setTimeout(() => void this.checkNow(), Math.max(interval, this.heldUntil - Date.now()));
  }

  private armExpiry(expiresAt: string): void {
    this.clearExpiry();
    const at = Date.parse(expiresAt);
    if (Number.isNaN(at)) {
      return;
    }
    this.expiryTimer = setTimeout(() => void this.checkNow(), Math.max(0, at - Date.now()) + EXPIRY_GRACE_MS);
  }

  private retarget(target: Target | null): void {
    this.generation += 1;
    this.target = target;
    this.inFlight = null;
    this.clearTimer();
    this.clearExpiry();
    this.clearLimit();
    this.gaveUp.set(false);
    this.failedPolls.set(0);
    // `heldUntil` survives a new target: the limit is the caller's, not the intent's.
    this.rateLimitedFor.set(null);
    if (target !== null) {
      this.stopped.set(null);
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private clearLimit(): void {
    if (this.limitTimer !== null) {
      clearTimeout(this.limitTimer);
      this.limitTimer = null;
    }
  }

  private clearExpiry(): void {
    if (this.expiryTimer !== null) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
  }
}
