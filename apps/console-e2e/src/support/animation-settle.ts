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
    const name =
      animation.animationName ||
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
export function restartingAnimationsMessage(lastSeen: readonly AnimationReport[], rounds: number): string {
  const seen = lastSeen.length > 0 ? describeReports(lastSeen) : 'none named (they ended between two reads)';
  return `animationsSettled: animations kept starting for ${String(rounds)} rounds; last seen: ${seen}.`;
}
