import { DOCUMENT } from '@angular/common';
import { DestroyRef, ErrorHandler, inject, Injectable, signal } from '@angular/core';
import { POLL_HIDDEN_MS } from './enrolment-watch';
import { PollTimer } from './poll-timer';
import { isFinalCheckState, type RunnerCheck } from './runner-check.model';
import { pollFailed, type RunnerWatchStop } from './runner-poll';
import { RunnersApi } from './runners.api';

/**
 * Poll rate of a runner check (#1059 PR 3, UX §12.2): every 2 s while visible, 15 s while hidden. A check takes up to
 * 150 s to be picked up and 30 s to run, so the 4 minutes are at most 120 reads, 30 a minute, inside the per-user
 * limit on account GETs (#879: 120 a minute, N9).
 */
export const CHECK_POLL_VISIBLE_MS = 2_000;
/** After this long from the start, the watch stops reading on its own (C6); a new start re-attaches. */
export const CHECK_WATCH_LIMIT_MS = 4 * 60_000;

interface Target {
  readonly accountId: string;
  readonly runnerId: string;
  readonly checkId: string;
}

/**
 * Follows one runner check (#1059 PR 3) until it is `passed` or `failed`, with `EnrolmentWatch`'s timers (the
 * `PollTimer`): a 429 holds the reads for its `Retry-After` and does not end the watch (N9), a lost session, role or
 * check ends it (`stopped`), and after `CHECK_WATCH_LIMIT_MS` it stops reading (`gaveUp`). Provide it in the
 * component that shows the check, so closing that stops every timer.
 */
@Injectable()
export class RunnerCheckWatch {
  private readonly api = inject(RunnersApi);
  private readonly errors = inject(ErrorHandler);
  private readonly poll = new PollTimer(
    inject(DOCUMENT),
    (isCurrent) => this.read(isCurrent),
    (error) => this.errors.handleError(error),
  );

  readonly check = signal<RunnerCheck | null>(null);
  readonly failedPolls = this.poll.failedPolls.asReadonly();
  readonly rateLimitedFor = this.poll.rateLimitedFor.asReadonly();
  /** `CHECK_WATCH_LIMIT_MS` passed without a final state (C6). */
  readonly gaveUp = this.poll.gaveUp.asReadonly();
  readonly stopped = signal<RunnerWatchStop | null>(null);

  private target: Target | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.poll.dispose());
  }

  /**
   * Follows `check`, as the start answered it, for `CHECK_WATCH_LIMIT_MS` from now. A final one is only shown: there
   * is nothing left to read.
   */
  watch(accountId: string, runnerId: string, check: RunnerCheck): void {
    this.check.set(check);
    this.stopped.set(null);
    if (isFinalCheckState(check.state)) {
      this.stop();
      return;
    }
    this.target = { accountId, runnerId, checkId: check.id };
    this.poll.start({
      visibleMs: CHECK_POLL_VISIBLE_MS,
      hiddenMs: POLL_HIDDEN_MS,
      limitMs: CHECK_WATCH_LIMIT_MS,
    });
  }

  stop(): void {
    this.target = null;
    this.poll.stop();
  }

  private async read(isCurrent: () => boolean): Promise<void> {
    const target = this.target;
    if (target === null) {
      return;
    }
    const read = await this.api.check(target.accountId, target.runnerId, target.checkId);
    if (!isCurrent()) {
      return;
    }
    if (!read.ok) {
      const stop = pollFailed(this.poll, read.failure);
      if (stop !== null) {
        this.stop();
        this.stopped.set(stop);
      }
      return;
    }
    this.poll.answered();
    this.check.set(read.value);
    if (isFinalCheckState(read.value.state)) {
      this.stop();
    }
  }
}
