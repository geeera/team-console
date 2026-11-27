import { LiveAnnouncer } from '@angular/cdk/a11y';
import { computed, DestroyRef, effect, inject, Injectable, signal, untracked } from '@angular/core';
import {
  isFinalCheckState,
  retryAfterMsOf,
  RunnerCheckWatch,
  RunnersApi,
  runnerFailureKeyOf,
  type RunnerFailure,
  type RunnerWatchStop,
} from '@console/entities/runner';
import { localTimeOf, TranslocoService } from '@console/shared/i18n';
import type { RunnerPlatform } from './add-runner.model';
import {
  CHECK_OUTDATED_RETRY_MS,
  CHECK_QUEUED_SLOW_MS,
  checkTitleKeyOf,
  checkViewOf,
  checkViewOfRefusal,
  isCheckInFlight,
  type CheckView,
} from './check-panel.model';

interface CheckTarget {
  readonly accountId: string;
  readonly runnerId: string;
  readonly platform: RunnerPlatform;
}

/** How step 4b arrived: the runner's release floor and the browser's network decide the automatic start (§12.1.2). */
export interface CheckArrival extends CheckTarget {
  readonly belowMinimum: boolean;
  readonly browserOnline: boolean;
}

const STOP_KEYS: Readonly<Record<RunnerWatchStop, string>> = {
  'session-expired': 'runners.err.sessionExpired',
  forbidden: 'runners.err.forbidden',
  'not-found': 'runners.err.notFound',
};

/**
 * The runner check on step 4b (#1059 PR 3, UX §12): it starts once by itself when the runner comes on line (not when
 * the runner is below the minimum version, which shows C8 at once, nor while the browser is offline), and again on
 * the owner's press. A start's own refusals are results (C5a, C7, C8, C9); a failed request is the wizard's §6
 * banner (`failureKey`) and puts the panel back where it was. The `RunnerCheckWatch` follows a started check. One
 * flow per sheet: provide it in the wizard beside the watch, so closing the sheet ends both.
 */
@Injectable()
export class RunnerCheckFlow {
  private readonly api = inject(RunnersApi);
  private readonly watch = inject(RunnerCheckWatch);
  private readonly announcer = inject(LiveAnnouncer);
  private readonly transloco = inject(TranslocoService);

  /** A state of the flow's own (C0, C1, a refusal), shown while no check is being watched. */
  private readonly local = signal<CheckView>({ kind: 'idle' });
  private readonly watching = signal(false);
  readonly queuedSlow = signal(false);
  /** False until a 429's `Retry-After` has passed (C9). */
  readonly retryReady = signal(true);
  /** The caller is no owner any more (a 403): no «Проверить» from now on (§6 state 20). */
  readonly forbidden = signal(false);
  /** A request that failed as a request: the wizard shows it in its §6 banner. */
  readonly failureKey = signal<string | null>(null);
  /** The check's own reads, for the wizard's shared «Нет связи» and 429 banners (§6 states 16, 16a). */
  readonly failedPolls = this.watch.failedPolls;
  readonly rateLimitedFor = this.watch.rateLimitedFor;

  readonly view = computed((): CheckView => {
    if (!this.watching()) {
      return this.local();
    }
    const check = this.watch.check();
    if (check === null) {
      return { kind: 'starting' };
    }
    if (!isFinalCheckState(check.state) && this.watch.gaveUp()) {
      return { kind: 'gaveUp' };
    }
    return checkViewOf(check, this.queuedSlow());
  });

  private target: CheckTarget | null = null;
  private autoStarted = false;
  private slowTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  /** What the watch's result was last announced for, so a 2 s poll never repeats it. */
  private announced: string | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.clearTimers());
    // A result the watch brings is announced once (§12.5); the start's own results are announced where they land.
    effect(() => {
      const view = this.view();
      const check = this.watch.check();
      if (!this.watching() || check === null || isCheckInFlight(view)) {
        return;
      }
      const key = `${check.id}:${view.kind}`;
      if (key !== this.announced) {
        this.announced = key;
        untracked(() => this.announceResult(view));
      }
    });
    effect(() => {
      const stopped = this.watch.stopped();
      if (stopped !== null) {
        untracked(() => this.watchStopped(stopped));
      }
    });
  }

  /**
   * Step 4b appeared. Answers whether the check starts by itself, so the wizard words its one announcement
   * (`live.onlineChecking` instead of `live.online`). There is no second automatic start in the same sheet.
   */
  arrive(arrival: CheckArrival): boolean {
    this.target = { accountId: arrival.accountId, runnerId: arrival.runnerId, platform: arrival.platform };
    if (this.autoStarted) {
      return false;
    }
    this.autoStarted = true;
    if (arrival.belowMinimum) {
      // Such a runner takes no work, so a check could only time out (§12.1.2): C8 without a request.
      this.local.set({ kind: 'outdated' });
      return false;
    }
    if (!arrival.browserOnline) {
      return false;
    }
    void this.start({ auto: true });
    return true;
  }

  /** The owner's «Проверить» / «Проверить снова». */
  async press(): Promise<void> {
    if (isCheckInFlight(this.view()) || !this.retryReady() || this.forbidden()) {
      return;
    }
    this.announce('runners.wizard.check.live.started');
    await this.start({ auto: false });
  }

  private async start({ auto, retried = false }: { auto: boolean; retried?: boolean }): Promise<void> {
    const target = this.target;
    if (target === null) {
      return;
    }
    const previous = this.view();
    this.watch.stop();
    this.watching.set(false);
    this.local.set({ kind: 'starting' });
    this.failureKey.set(null);
    const started = await this.api.startCheck(target.accountId, target.runnerId);
    if (target !== this.target) {
      return;
    }
    if (started.ok) {
      this.armQueuedSlow();
      this.announced = null;
      this.watching.set(true);
      this.watch.watch(target.accountId, target.runnerId, started.value);
      return;
    }
    const { failure } = started;
    if (auto && !retried && failure.slug === 'runner-outdated') {
      // N8: the declaration may land a moment after the runner's first signal; retry once, silently.
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        void this.start({ auto, retried: true });
      }, CHECK_OUTDATED_RETRY_MS);
      return;
    }
    this.refused(failure, previous);
  }

  private refused(failure: RunnerFailure, previous: CheckView): void {
    if (failure.kind === 'rate-limited') {
      const waitMs = retryAfterMsOf(failure);
      const view: CheckView = { kind: 'rateLimited', until: Date.now() + waitMs };
      this.local.set(view);
      this.holdRetry(waitMs);
      this.announce(checkTitleKeyOf(view, this.platform()), {
        time: localTimeOf(view.until, this.transloco.getActiveLang()),
      });
      return;
    }
    const refusal = checkViewOfRefusal(failure.slug);
    if (refusal !== null) {
      this.local.set(refusal);
      this.announceResult(refusal);
      return;
    }
    // A request that failed (network, 5xx, 401, 403, 404): the §6 banner says so, the panel goes back.
    if (failure.kind === 'forbidden' || failure.kind === 'session-expired') {
      this.forbidden.set(true);
    }
    this.failureKey.set(runnerFailureKeyOf(failure));
    this.local.set(isCheckInFlight(previous) ? { kind: 'idle' } : previous);
  }

  private watchStopped(stopped: RunnerWatchStop): void {
    if (stopped !== 'not-found') {
      this.forbidden.set(true);
    }
    this.failureKey.set(STOP_KEYS[stopped]);
    this.watching.set(false);
    this.local.set({ kind: 'idle' });
  }

  private announceResult(view: CheckView): void {
    if (view.kind === 'passed') {
      if (view.version === null) {
        this.announce('runners.wizard.check.live.passedNoVersion');
      } else {
        this.announce('runners.wizard.check.live.passed', { version: view.version });
      }
      return;
    }
    const title = this.transloco.translate(checkTitleKeyOf(view, this.platform()));
    // §12.5: C6 and C8 are announced by their title; every other result as «Проверка не прошла: …».
    if (view.kind === 'gaveUp' || view.kind === 'outdated') {
      void this.announcer.announce(title, 'polite');
    } else {
      this.announce('runners.wizard.check.live.failed', { title });
    }
  }

  private platform(): RunnerPlatform {
    return this.target?.platform ?? 'mac';
  }

  private armQueuedSlow(): void {
    this.queuedSlow.set(false);
    if (this.slowTimer !== null) {
      clearTimeout(this.slowTimer);
    }
    this.slowTimer = setTimeout(() => {
      this.slowTimer = null;
      this.queuedSlow.set(true);
    }, CHECK_QUEUED_SLOW_MS);
  }

  /** C9: the button re-enables itself when the limit ends; nothing starts by itself. */
  private holdRetry(waitMs: number): void {
    this.retryReady.set(false);
    if (this.readyTimer !== null) {
      clearTimeout(this.readyTimer);
    }
    this.readyTimer = setTimeout(() => {
      this.readyTimer = null;
      this.retryReady.set(true);
    }, waitMs);
  }

  private announce(key: string, params?: Record<string, unknown>): void {
    void this.announcer.announce(this.transloco.translate(key, params), 'polite');
  }

  private clearTimers(): void {
    for (const timer of [this.slowTimer, this.retryTimer, this.readyTimer]) {
      if (timer !== null) {
        clearTimeout(timer);
      }
    }
    this.slowTimer = null;
    this.retryTimer = null;
    this.readyTimer = null;
  }
}
