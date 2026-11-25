/**
 * The in-page half of `finishAnimations()` (`support/motion.ts`) and of the axe gate's motion watch
 * (`support/axe.ts`). `finishRunningAnimations` and `watchMotion` are passed to `page.evaluate`, which sends their
 * source to the browser, so each must stay self-contained: no imports, no module-level helpers. The default `env` is
 * the real page; the unit test passes a fake one.
 *
 * Nothing here waits for an animation's own clock (#971): under CPU load WebKit's animation clock lags wall time and
 * a `finished` promise can stay unresolved at 0 ms left, so every time-based settle failed there (#979, #980).
 * `Animation.finish()` jumps to the end state at once instead.
 *
 * The same lag has a second face (#1018): Playwright's WebKit on Linux can leave an animation that ran to its end by
 * itself listed as `finished`, past its end and filling nothing, with the element's style still at an earlier frame —
 * the whole routed page at partial opacity, for as long as nothing else invalidates it. Such a lingering animation
 * is finished as well, which makes WebKit apply the end state.
 */

/** The part of `Element` a report names. */
export interface AnimatedTarget {
  readonly tagName: string;
  readonly id: string;
  readonly classList: ArrayLike<string>;
}

/** The part of `Animation` (and `CSSAnimation` / `CSSTransition`) that is read; a real `Animation` fits it. */
export interface FinishableAnimation {
  readonly id: string;
  readonly playState: string;
  readonly animationName?: string;
  readonly transitionProperty?: string;
  readonly effect: {
    getComputedTiming(): { readonly iterations?: number; readonly progress?: number | null };
    readonly target?: AnimatedTarget | null;
    readonly pseudoElement?: string | null;
  } | null;
  finish(): void;
}

export interface FinishEnv {
  readonly animations: () => readonly FinishableAnimation[];
  readonly nextFrame: () => Promise<void>;
}

export interface FinishOptions {
  /** Passes that may each find something to finish before the page counts as never coming to rest. */
  readonly maxRounds: number;
  /** Frames between two passes: `animationend` is sent on the next frame, and its handler may start the next step. */
  readonly framesBetweenRounds: number;
}

/** One animation as it was seen in the page; `describeMotion()` turns it into the text of an error. */
export interface MotionReport {
  /** `animation-name`, the transitioned property, or the Web Animations `id`; empty when it has none. */
  readonly name: string;
  readonly tagName: string | null;
  readonly id: string;
  readonly classes: readonly string[];
  readonly pseudoElement: string | null;
  /** Why `finish()` did not end it, when it did not. */
  readonly reason?: string;
}

export interface FinishResult {
  /** Running animations that repeat forever: `finish()` throws on them, so they are left running and reported. */
  readonly endless: readonly MotionReport[];
  /** Finite animations `finish()` threw on, left running, or left applied past their end. */
  readonly refused: readonly MotionReport[];
  /** What the last pass still had to finish when `maxRounds` ran out; empty when the page came to rest. */
  readonly restless: readonly MotionReport[];
}

/**
 * Jumps every running finite animation to its end state, pass after pass, until a pass finds none left: the
 * `animationend` of one step can start the next (`tc-roll` steps through its values, a badge shrinks out after its
 * roll), so one pass is not always the end.
 *
 * Only `running` animations are touched, and lingering ones (#1018): `finished`, yet still listed although their
 * effect has no progress, i.e. applies nothing. A browser that follows the spec lists no such animation — one past
 * its end is listed only while it fills forwards, and then its progress is 1 — so this is WebKit not having applied
 * the end state yet, and the style is still a frame from mid-way. A paused one — the Undo toast's hairline stops
 * while the pointer or focus is on the toast (#409) — is a still frame the owner really sees, and stays as it is. A
 * finished one that fills forwards is already at its end.
 */
export async function finishRunningAnimations(
  options: FinishOptions,
  env: FinishEnv = {
    animations: () => document.getAnimations(),
    nextFrame: () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  },
): Promise<FinishResult> {
  const report = (animation: FinishableAnimation, reason?: string): MotionReport => {
    const element = animation.effect?.target ?? null;
    return {
      name:
        animation.animationName ||
        (animation.transitionProperty ? `transition: ${animation.transitionProperty}` : '') ||
        animation.id,
      tagName: element?.tagName ?? null,
      id: element?.id ?? '',
      classes: element ? Array.from(element.classList) : [],
      pseudoElement: animation.effect?.pseudoElement ?? null,
      ...(reason === undefined ? {} : { reason }),
    };
  };
  const isEndless = (animation: FinishableAnimation): boolean =>
    animation.effect?.getComputedTiming().iterations === Infinity;
  const isLingering = (animation: FinishableAnimation): boolean =>
    animation.playState === 'finished' && animation.effect?.getComputedTiming().progress === null;

  let lastFinished: MotionReport[] = [];
  // `finish()` changes nothing that can be read on a lingering animation; it worked if the next pass no longer lists it.
  const finishedLingering = new Set<FinishableAnimation>();
  for (let round = 0; round < options.maxRounds; round++) {
    const listed = env.animations();
    const running = listed.filter((animation) => animation.playState === 'running');
    const finite = running.filter((animation) => !isEndless(animation));
    const lingering = listed.filter(isLingering);
    if (finite.length === 0 && lingering.length === 0) {
      return { endless: running.map((animation) => report(animation)), refused: [], restless: [] };
    }
    const refused: MotionReport[] = [];
    for (const animation of lingering) {
      if (finishedLingering.has(animation)) {
        refused.push(report(animation, 'still applied past its end after finish()'));
        continue;
      }
      try {
        animation.finish();
      } catch (error: unknown) {
        refused.push(report(animation, error instanceof Error ? error.message : String(error)));
        continue;
      }
      finishedLingering.add(animation);
    }
    for (const animation of finite) {
      try {
        animation.finish();
      } catch (error: unknown) {
        refused.push(report(animation, error instanceof Error ? error.message : String(error)));
        continue;
      }
      if (animation.playState === 'running') {
        refused.push(report(animation, 'still running after finish()'));
      }
    }
    if (refused.length > 0) {
      return { endless: [], refused, restless: [] };
    }
    lastFinished = [...finite, ...lingering].map((animation) => report(animation));
    for (let frame = 0; frame < options.framesBetweenRounds; frame++) {
      await env.nextFrame();
    }
  }
  return { endless: [], refused: [], restless: lastFinished };
}

/** What `watchMotion()` hands back: `stop()` ends the watch and returns everything that moved since it began. */
export interface MotionWatch {
  stop(): MotionReport[];
}

/**
 * Records every CSS animation and transition that starts from now on. `stop()` adds whatever is running at that
 * moment (a Web Animations `animate()` sends no start event), so an empty answer means nothing moved in between.
 */
export function watchMotion(): MotionWatch {
  const moved: MotionReport[] = [];
  const targetOf = (target: EventTarget | null): Pick<MotionReport, 'tagName' | 'id' | 'classes'> =>
    target instanceof Element
      ? { tagName: target.tagName, id: target.id, classes: Array.from(target.classList) }
      : { tagName: null, id: '', classes: [] };
  const onAnimationStart = (event: Event): void => {
    const { animationName, pseudoElement } = event as AnimationEvent;
    moved.push({ name: animationName, ...targetOf(event.target), pseudoElement: pseudoElement || null });
  };
  const onTransitionRun = (event: Event): void => {
    const { propertyName, pseudoElement } = event as TransitionEvent;
    moved.push({
      name: `transition: ${propertyName}`,
      ...targetOf(event.target),
      pseudoElement: pseudoElement || null,
    });
  };
  document.addEventListener('animationstart', onAnimationStart, true);
  document.addEventListener('transitionrun', onTransitionRun, true);
  return {
    stop: () => {
      document.removeEventListener('animationstart', onAnimationStart, true);
      document.removeEventListener('transitionrun', onTransitionRun, true);
      for (const animation of document.getAnimations()) {
        if (animation.playState !== 'running') {
          continue;
        }
        const effect = animation.effect instanceof KeyframeEffect ? animation.effect : null;
        moved.push({
          name:
            (animation instanceof CSSAnimation ? animation.animationName : '') ||
            (animation instanceof CSSTransition ? `transition: ${animation.transitionProperty}` : '') ||
            animation.id,
          ...targetOf(effect?.target ?? null),
          pseudoElement: effect?.pseudoElement ?? null,
        });
      }
      return moved;
    },
  };
}

/** `tc-meter-fill on i.tc-meter__fill`, with `::pseudo` and the reason `finish()` failed when there is one. */
export function describeMotion(report: MotionReport): string {
  // Angular scopes component keyframes as `_ngcontent-ng-c123_tc-spin`; the message names the source's `tc-spin`.
  const name = report.name.replace(/^_ngcontent-[^_]+_/, '') || '(unnamed animation)';
  let target = '(no target)';
  if (report.tagName !== null) {
    const classes = report.classes.map((value) => `.${value}`).join('');
    target = `${report.tagName.toLowerCase()}${report.id ? `#${report.id}` : ''}${classes}${report.pseudoElement ?? ''}`;
  }
  return `${name} on ${target}${report.reason === undefined ? '' : ` (${report.reason})`}`;
}

function describeAll(reports: readonly MotionReport[]): string {
  return [...new Set(reports.map(describeMotion))].join('; ');
}

/** The error for an animation that repeats forever while axe is about to measure the page. */
export function endlessAnimationsMessage(endless: readonly MotionReport[]): string {
  return (
    `axe gate: an endless animation is still running under reduced motion and cannot be finished: ` +
    `${describeAll(endless)}. axe would measure a frame in the middle of it. Stop it under reduced motion ` +
    '(`animation: none`, as tc-spinner and tc-live-dot do) or pause it for the state the test means.'
  );
}

/** The error for a finite animation `finish()` could not end. */
export function refusedAnimationsMessage(refused: readonly MotionReport[]): string {
  return `finishAnimations: finish() did not end: ${describeAll(refused)}.`;
}

/** The error for a page that started new animations pass after pass until the cap. */
export function restlessAnimationsMessage(restless: readonly MotionReport[], rounds: number): string {
  return (
    `finishAnimations: the page kept starting animations for ${String(rounds)} passes and never came to rest; ` +
    `the last pass finished: ${describeAll(restless)}.`
  );
}

/** The error for a page that moved during every axe scan it was given. */
export function movedDuringScanMessage(moved: readonly MotionReport[], scans: number): string {
  return (
    `axe gate: something animated during each of ${String(scans)} scans, so none of them measured a still page; ` +
    `the last scan saw: ${describeAll(moved)}. Wait for the state the test means before the scan.`
  );
}
