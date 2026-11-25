import type { Page } from '@playwright/test';

/**
 * The in-page half of `animationsSettled()` (`support/axe.ts`): one round of "is anything still moving, and if so,
 * wait for it — but never for long". `settleRound` is passed to `page.evaluate`, which sends its source to the
 * browser, so it must stay self-contained: no imports, no module-level helpers. The default `env` is the real page;
 * the unit test passes a fake one.
 */

/** The part of `Element` a report names. */
export interface AnimatedTarget {
  readonly tagName: string;
  readonly id: string;
  readonly classList: ArrayLike<string>;
}

/** The part of `Animation` (and `CSSAnimation` / `CSSTransition`) the wait reads; a real `Animation` fits it. */
export interface SettleAnimation {
  readonly id: string;
  readonly playState: string;
  readonly playbackRate: number;
  readonly finished: Promise<unknown>;
  readonly animationName?: string;
  readonly transitionProperty?: string;
  readonly effect: {
    getComputedTiming(): {
      readonly iterations?: number;
      readonly endTime?: unknown;
      readonly localTime?: unknown;
    };
    readonly target?: AnimatedTarget | null;
    readonly pseudoElement?: string | null;
  } | null;
}

export interface SettleEnv {
  readonly animations: () => readonly SettleAnimation[];
  readonly nextFrame: () => Promise<void>;
}

export interface SettleOptions {
  /** Frames in a row with nothing finite running before the page counts as settled. */
  readonly quietFrames: number;
  /** The longest one animation is waited for; anything with more time left fails the round at once. */
  readonly maxWaitMs: number;
  /** Added to an animation's own remaining time, for a loaded machine's late frames. */
  readonly slackMs: number;
}

/** One animation as the failure message names it. */
export interface AnimationReport {
  /** `animation-name`, the transitioned property, or the Web Animations `id`. */
  readonly name: string;
  /** `tag#id.class…`, with `::pseudo` when the animation runs on a pseudo-element. */
  readonly target: string;
  /** Time left to its end at the current rate; `null` when the timing is not a plain number. */
  readonly remainingMs: number | null;
}

export type SettleRound =
  | { readonly quiet: true }
  | {
      readonly quiet: false;
      /** Everything finite that was running when the round started waiting. */
      readonly running: readonly AnimationReport[];
      /** The ones that did not finish within their budget. */
      readonly stuck: readonly AnimationReport[];
    };

/**
 * Waits for `quietFrames` frames in a row with no finite animation running; if one is seen, waits for each running
 * one to finish within `min(remaining + slackMs, maxWaitMs)` and reports which did not.
 *
 * Only `running` animations count. A paused one — the Undo toast's 10 s hairline stops while the pointer or focus is
 * on the toast (#409) — is a still frame: its `finished` never resolves while it is paused, so waiting on it hung the
 * scan for the whole test timeout (#971). Endless ones (spinners, the live dot) are never waited for either.
 */
export async function settleRound(
  options: SettleOptions,
  env: SettleEnv = {
    animations: () => document.getAnimations(),
    nextFrame: () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  },
): Promise<SettleRound> {
  const isMoving = (animation: SettleAnimation): boolean =>
    animation.playState === 'running' && animation.effect?.getComputedTiming().iterations !== Infinity;

  const describe = (animation: SettleAnimation): AnimationReport => {
    // Angular scopes component keyframes as `_ngcontent-ng-c123_tc-spin`; the message names the source's `tc-spin`.
    const name =
      animation.animationName?.replace(/^_ngcontent-[^_]+_/, '') ||
      (animation.transitionProperty ? `transition: ${animation.transitionProperty}` : '') ||
      animation.id ||
      '(unnamed animation)';
    const effect = animation.effect;
    const element = effect?.target;
    let target = '(no target)';
    if (element) {
      const classes = Array.from(element.classList)
        .map((value) => `.${value}`)
        .join('');
      target = `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${classes}`;
      if (effect?.pseudoElement) {
        target += effect.pseudoElement;
      }
    }
    let remainingMs: number | null = null;
    const timing = effect?.getComputedTiming();
    const rate = Math.abs(animation.playbackRate);
    if (timing && typeof timing.endTime === 'number' && typeof timing.localTime === 'number' && rate > 0) {
      remainingMs = Math.max(0, (timing.endTime - timing.localTime) / rate);
    }
    return { name, target, remainingMs };
  };

  let quietSoFar = true;
  for (let frame = 0; frame < options.quietFrames && quietSoFar; frame++) {
    quietSoFar = !env.animations().some(isMoving);
    if (quietSoFar) {
      await env.nextFrame();
    }
  }
  if (quietSoFar && !env.animations().some(isMoving)) {
    return { quiet: true };
  }

  const moving = env.animations().filter(isMoving);
  if (moving.length === 0) {
    // Whatever was seen ended between two reads: not quiet for long enough yet, so the caller runs another round.
    return { quiet: false, running: [], stuck: [] };
  }

  const outcomes = await Promise.all(
    moving.map(async (animation) => {
      const report = describe(animation);
      if (report.remainingMs !== null && report.remainingMs > options.maxWaitMs) {
        return { report, finished: false };
      }
      const budgetMs = Math.min(
        options.maxWaitMs,
        (report.remainingMs ?? options.maxWaitMs) + options.slackMs,
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), budgetMs);
      });
      // A navigation or a next value cancels an animation mid-way (#946): `finished` rejects with AbortError, which
      // is the animation going away, i.e. settled. Anything else is a real error and fails the scan.
      const ended = animation.finished.then(
        () => true as const,
        (error: unknown) => {
          if (error instanceof DOMException && error.name === 'AbortError') {
            return true as const;
          }
          throw error;
        },
      );
      try {
        return { report, finished: await Promise.race([ended, timedOut]) };
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  return {
    quiet: false,
    running: outcomes.map((outcome) => outcome.report),
    stuck: outcomes.filter((outcome) => !outcome.finished).map((outcome) => outcome.report),
  };
}

function describeReports(reports: readonly AnimationReport[]): string {
  return reports
    .map((report) => {
      const left =
        report.remainingMs === null
          ? 'time left unknown'
          : `${String(Math.round(report.remainingMs))} ms left`;
      return `${report.name} on ${report.target} (${left})`;
    })
    .join('; ');
}

/** The error for animations that outlived their wait: which one, on which element, and what to do about it. */
export function stuckAnimationsMessage(stuck: readonly AnimationReport[], maxWaitMs: number): string {
  return (
    `animationsSettled: still running after its wait (at most ${String(maxWaitMs)} ms each): ${describeReports(stuck)}. ` +
    'axe would measure contrast mid-animation. Wait for the state the test means (hover or focus pauses an Undo ' +
    'toast), or make the animation finite and short.'
  );
}

/** The error for a page that kept starting new animations round after round. */
export function restartingAnimationsMessage(
  lastSeen: readonly AnimationReport[],
  rounds: number,
  elapsedMs: number,
): string {
  const seen = lastSeen.length > 0 ? describeReports(lastSeen) : 'none named (they ended between two reads)';
  return (
    `animationsSettled: animations kept starting for ${String(rounds)} rounds over ${String(Math.round(elapsedMs))} ms; ` +
    `last seen: ${seen}.`
  );
}

/** What the wait may spend. */
export interface SettleLimits {
  /** Rounds that may each find something new running before the page counts as restarting forever. */
  readonly maxRounds: number;
  /** The whole wait; checked between rounds, so it can overrun by one round (`maxWaitMs + slackMs` at most). */
  readonly totalMs: number;
  /** Named in the stuck-animation error. */
  readonly maxWaitMs: number;
}

/** One round can wait up to `maxWaitMs` per animation; the #506 motion tokens top out at 1.6 s (`--dur-pulse`). */
export const SETTLE_OPTIONS: SettleOptions = { quietFrames: 4, maxWaitMs: 3000, slackMs: 250 };
/** Enough for a screen that chains a few enters (route, sheet, list rows) one after another. */
export const SETTLE_MAX_ROUNDS = 20;
/**
 * Under the 30 s test timeout (`playwright.config.ts`) with room for one more round and the waits before it
 * (`animationsSettled()`), so this module's named error is what the run shows, not a bare timeout.
 */
export const SETTLE_TOTAL_MS = 20_000;

/**
 * Runs `round` until the page is quiet. Throws a named error when an animation outlives its wait, or when the page
 * keeps starting new ones until `maxRounds` or `totalMs` runs out. Paused and endless animations never count, so
 * this cannot hang on them (#971).
 */
export async function settleUntilQuiet(
  round: () => Promise<SettleRound>,
  budget: SettleLimits,
  now: () => number = Date.now,
): Promise<void> {
  const startedAt = now();
  let lastSeen: readonly AnimationReport[] = [];
  let rounds = 0;
  // At least one round runs even when earlier waits spent the whole budget: a quiet page must pass.
  do {
    rounds++;
    const result = await round();
    if (result.quiet) {
      return;
    }
    if (result.stuck.length > 0) {
      throw new Error(stuckAnimationsMessage(result.stuck, budget.maxWaitMs));
    }
    lastSeen = result.running.length > 0 ? result.running : lastSeen;
  } while (rounds < budget.maxRounds && now() - startedAt < budget.totalMs);
  throw new Error(restartingAnimationsMessage(lastSeen, rounds, now() - startedAt));
}

/** Waits until nothing finite is running on the page, within the shared budget. */
export async function settlePage(page: Page, totalMs: number = SETTLE_TOTAL_MS): Promise<void> {
  await settleUntilQuiet(() => page.evaluate(settleRound, SETTLE_OPTIONS), {
    maxRounds: SETTLE_MAX_ROUNDS,
    totalMs,
    maxWaitMs: SETTLE_OPTIONS.maxWaitMs,
  });
}
