import { DOCUMENT } from '@angular/common';
import { DestroyRef, ErrorHandler, inject, Injectable, signal } from '@angular/core';
import type { EnrolmentIntentDto, EnrolmentIntentState, RunnerDto } from '@shared/contracts';
import { PollTimer } from './poll-timer';
import { pollFailed, type RunnerWatchStop } from './runner-poll';
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
/** A local expiry is confirmed by the server a moment later: its clock, not ours, decides. */
const EXPIRY_GRACE_MS = 500;

/** States after which the intent never changes again, so polling it stops. */
const SETTLED: ReadonlySet<EnrolmentIntentState> = new Set(['approved', 'used', 'expired', 'withdrawn']);

/** Why a watch stopped on its own: the session ended, the caller lost the owner role, or the intent is not theirs. */
export type EnrolmentWatchStop = RunnerWatchStop;

type Target =
  | { readonly kind: 'intent'; readonly accountId: string; readonly intentId: string }
  | { readonly kind: 'runner'; readonly accountId: string; readonly runnerId: string };

/**
 * The add-runner wizard's polling model (#634 PR 4): an intent until it settles, then the runner it created until it
 * is online. Every 3 s (intent) or 5 s (runner) while the page is visible, every 15 s while it is hidden, and once at
 * once when the page becomes visible again or the network comes back (the `PollTimer`). The runner is polled for
 * `RUNNER_WATCH_LIMIT_MS` at most; after that only `checkNow()` reads (#878). One watch per wizard: provide it in the
 * component, so closing the sheet stops every timer. The intent id is only ever in the path of the owner's own GET.
 */
@Injectable()
export class EnrolmentWatch {
  private readonly api = inject(RunnersApi);
  private readonly errors = inject(ErrorHandler);
  private readonly poll = new PollTimer(
    inject(DOCUMENT),
    (isCurrent) => this.read(isCurrent),
    // RunnersApi never throws by contract; a bug in a guard or a signal must still reach the error handler.
    (error) => this.errors.handleError(error),
  );

  readonly intent = signal<EnrolmentIntentDto | null>(null);
  readonly runner = signal<RunnerDto | null>(null);
  readonly minimumVersion = signal<string | null>(null);
  readonly failedPolls = this.poll.failedPolls.asReadonly();
  readonly stopped = signal<EnrolmentWatchStop | null>(null);
  /** The runner poll ran out its `RUNNER_WATCH_LIMIT_MS`: nothing polls until `checkNow()` (the owner's re-check). */
  readonly gaveUp = this.poll.gaveUp.asReadonly();
  /** Seconds the last 429 asked the watch to wait (#879); `null` once a read succeeds again. */
  readonly rateLimitedFor = this.poll.rateLimitedFor.asReadonly();

  private target: Target | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.clearExpiry();
      this.poll.dispose();
    });
  }

  /** Watches a fresh intent; `expiresAt` arms the one confirming read at local expiry. */
  watchIntent(accountId: string, intentId: string, expiresAt: string): void {
    this.retarget({ kind: 'intent', accountId, intentId });
    this.intent.set(null);
    this.poll.start({ visibleMs: INTENT_POLL_VISIBLE_MS, hiddenMs: POLL_HIDDEN_MS, limitMs: null });
    this.armExpiry(expiresAt);
  }

  /** Watches the runner an approval created until `GET …/runners` shows it online, for `RUNNER_WATCH_LIMIT_MS`. */
  watchRunner(accountId: string, runnerId: string): void {
    this.retarget({ kind: 'runner', accountId, runnerId });
    this.runner.set(null);
    this.poll.start({
      visibleMs: RUNNER_POLL_VISIBLE_MS,
      hiddenMs: POLL_HIDDEN_MS,
      limitMs: RUNNER_WATCH_LIMIT_MS,
    });
  }

  stop(): void {
    this.retarget(null);
  }

  /** One read now, whatever the timer says; joins a read already under way. */
  checkNow(): Promise<void> {
    return this.poll.checkNow();
  }

  private async read(isCurrent: () => boolean): Promise<void> {
    const target = this.target;
    if (target === null) {
      return;
    }
    if (target.kind === 'intent') {
      const read = await this.api.enrolmentIntent(target.accountId, target.intentId);
      if (!isCurrent()) {
        return;
      }
      if (!read.ok) {
        this.stopWith(pollFailed(this.poll, read.failure));
        return;
      }
      this.poll.answered();
      this.intent.set(read.value);
      if (SETTLED.has(read.value.state)) {
        this.retarget(null);
      } else {
        this.armExpiry(read.value.expiresAt);
      }
      return;
    }
    const read = await this.api.list(target.accountId);
    if (!isCurrent()) {
      return;
    }
    if (!read.ok) {
      this.stopWith(pollFailed(this.poll, read.failure));
      return;
    }
    this.poll.answered();
    const runner = read.value.runners.find((row) => row.id === target.runnerId) ?? null;
    this.runner.set(runner);
    this.minimumVersion.set(read.value.release.minimumVersion);
    if (runner?.online === true) {
      this.retarget(null);
    }
  }

  private stopWith(stop: EnrolmentWatchStop | null): void {
    if (stop !== null) {
      this.retarget(null);
      this.stopped.set(stop);
    }
  }

  private armExpiry(expiresAt: string): void {
    this.clearExpiry();
    const at = Date.parse(expiresAt);
    if (Number.isNaN(at)) {
      return;
    }
    this.expiryTimer = setTimeout(() => void this.checkNow(), Math.max(0, at - Date.now()) + EXPIRY_GRACE_MS);
  }

  /** A new target clears the last stop; no target stops every timer. */
  private retarget(target: Target | null): void {
    this.target = target;
    this.clearExpiry();
    if (target === null) {
      this.poll.stop();
    } else {
      this.stopped.set(null);
    }
  }

  private clearExpiry(): void {
    if (this.expiryTimer !== null) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
  }
}
