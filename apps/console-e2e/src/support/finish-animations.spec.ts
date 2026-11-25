import { describe, expect, it } from 'vitest';
import {
  describeMotion,
  endlessAnimationsMessage,
  type FinishableAnimation,
  type FinishEnv,
  type FinishOptions,
  finishRunningAnimations,
  type MotionReport,
  movedDuringScanMessage,
  refusedAnimationsMessage,
  restlessAnimationsMessage,
} from './finish-animations';

const OPTIONS: FinishOptions = { maxRounds: 5, framesBetweenRounds: 2 };

interface FakeAnimation extends FinishableAnimation {
  playState: string;
  finishCalls: number;
}

function fakeAnimation(
  init: {
    readonly name?: string;
    readonly transition?: string;
    readonly playState?: string;
    readonly iterations?: number;
    readonly target?: {
      readonly tagName: string;
      readonly id?: string;
      readonly classes?: readonly string[];
    } | null;
    readonly pseudoElement?: string;
    /** What `finish()` does instead of ending the animation. */
    readonly onFinish?: (animation: FakeAnimation) => void;
  } = {},
): FakeAnimation {
  const animation: FakeAnimation = {
    id: '',
    playState: init.playState ?? 'running',
    finishCalls: 0,
    ...(init.transition === undefined
      ? { animationName: init.name ?? 'm-enter' }
      : { transitionProperty: init.transition }),
    effect: {
      getComputedTiming: () => ({ iterations: init.iterations ?? 1 }),
      target:
        init.target === null
          ? null
          : {
              tagName: init.target?.tagName ?? 'DIV',
              id: init.target?.id ?? '',
              classList: [...(init.target?.classes ?? [])],
            },
      pseudoElement: init.pseudoElement ?? null,
    },
    finish: () => {
      animation.finishCalls++;
      if (init.onFinish) {
        init.onFinish(animation);
      } else {
        animation.playState = 'finished';
      }
    },
  };
  return animation;
}

/** A page whose animations are `live()`, read fresh on every pass, counting the frames waited. */
function env(live: () => readonly FinishableAnimation[]): FinishEnv & { frames: number } {
  const page = {
    frames: 0,
    animations: live,
    nextFrame: () => {
      page.frames++;
      return Promise.resolve();
    },
  };
  return page;
}

describe('finishRunningAnimations', () => {
  it('finishes nothing and waits for no frame on a page at rest', async () => {
    const page = env(() => []);
    expect(await finishRunningAnimations(OPTIONS, page)).toEqual({ endless: [], refused: [], restless: [] });
    expect(page.frames).toBe(0);
  });

  it('jumps a running finite animation to its end instead of waiting for it', async () => {
    const fade = fakeAnimation();
    const page = env(() => [fade]);
    expect(await finishRunningAnimations(OPTIONS, page)).toEqual({ endless: [], refused: [], restless: [] });
    expect(fade.finishCalls).toBe(1);
    expect(fade.playState).toBe('finished');
    expect(page.frames).toBe(OPTIONS.framesBetweenRounds);
  });

  it('leaves paused and already finished animations as they are (a hovered Undo toast hairline, #971)', async () => {
    const hairline = fakeAnimation({ name: 'tc-toast-undo-run', playState: 'paused' });
    const filled = fakeAnimation({ name: 'm-leave', playState: 'finished' });
    const idle = fakeAnimation({ playState: 'idle' });
    const result = await finishRunningAnimations(
      OPTIONS,
      env(() => [hairline, filled, idle]),
    );
    expect(result).toEqual({ endless: [], refused: [], restless: [] });
    expect([hairline.finishCalls, filled.finishCalls, idle.finishCalls]).toEqual([0, 0, 0]);
  });

  it('reports a running endless animation by name and element, without calling finish() on it', async () => {
    const dot = fakeAnimation({
      name: '_ngcontent-ng-c42_tc-live-dot',
      iterations: Infinity,
      target: { tagName: 'TC-LIVE-DOT', classes: ['tc-live-dot--deep'] },
    });
    const fade = fakeAnimation();
    const result = await finishRunningAnimations(
      OPTIONS,
      env(() => [dot, fade]),
    );
    expect(dot.finishCalls).toBe(0);
    expect(fade.finishCalls).toBe(1);
    expect(result.endless.map(describeMotion)).toEqual(['tc-live-dot on tc-live-dot.tc-live-dot--deep']);
    expect(result.refused).toEqual([]);
    expect(result.restless).toEqual([]);
  });

  it('does not report an endless animation that is paused', async () => {
    const dot = fakeAnimation({ name: 'tc-live-dot', iterations: Infinity, playState: 'paused' });
    const result = await finishRunningAnimations(
      OPTIONS,
      env(() => [dot]),
    );
    expect(result.endless).toEqual([]);
  });

  it('finishes the next step an animationend starts (a roll through several values)', async () => {
    const steps = [fakeAnimation({ name: 'tc-roll-in' }), fakeAnimation({ name: 'tc-roll-in' })];
    const badge = fakeAnimation({ name: 'tc-count-badge-out' });
    // Each step appears only once the one before it has finished, as its `animationend` handler would start it.
    const page = env(() => {
      const next = [...steps, badge].find((animation) => animation.playState === 'running');
      return next ? [next] : [];
    });
    expect(await finishRunningAnimations(OPTIONS, page)).toEqual({ endless: [], refused: [], restless: [] });
    expect([...steps, badge].map((animation) => animation.finishCalls)).toEqual([1, 1, 1]);
    expect(page.frames).toBe(3 * OPTIONS.framesBetweenRounds);
  });

  it('reports a finite animation finish() throws on, with the reason', async () => {
    const broken = fakeAnimation({
      name: 'tc-sheet-rise',
      target: { tagName: 'DIV', id: 'sheet', classes: ['tc-sheet'] },
      onFinish: () => {
        throw new Error('InvalidStateError: playback rate is 0');
      },
    });
    const result = await finishRunningAnimations(
      OPTIONS,
      env(() => [broken]),
    );
    expect(result.refused.map(describeMotion)).toEqual([
      'tc-sheet-rise on div#sheet.tc-sheet (InvalidStateError: playback rate is 0)',
    ]);
  });

  it('reports a finite animation that is still running after finish()', async () => {
    const stuck = fakeAnimation({ onFinish: () => undefined });
    const result = await finishRunningAnimations(
      OPTIONS,
      env(() => [stuck]),
    );
    expect(result.refused.map(describeMotion)).toEqual(['m-enter on div (still running after finish())']);
    expect(stuck.finishCalls).toBe(1);
  });

  it('gives up after maxRounds on a page that starts a new animation every pass, naming the last one', async () => {
    const started: FakeAnimation[] = [];
    const page = env(() => {
      const fresh = fakeAnimation({ transition: 'opacity', target: { tagName: 'LI', classes: ['row'] } });
      started.push(fresh);
      return [fresh];
    });
    const result = await finishRunningAnimations(OPTIONS, page);
    expect(started).toHaveLength(OPTIONS.maxRounds);
    expect(result.restless.map(describeMotion)).toEqual(['transition: opacity on li.row']);
    expect(result.endless).toEqual([]);
  });
});

describe('describeMotion', () => {
  const base: MotionReport = { name: 'm-enter', tagName: 'SPAN', id: '', classes: [], pseudoElement: null };

  it('names the pseudo-element an animation runs on', () => {
    expect(describeMotion({ ...base, classes: ['tc-toast__bar'], pseudoElement: '::after' })).toBe(
      'm-enter on span.tc-toast__bar::after',
    );
  });

  it('says so when an animation has no name or no target', () => {
    expect(describeMotion({ ...base, name: '', tagName: null })).toBe('(unnamed animation) on (no target)');
  });
});

describe('failure messages', () => {
  const dot: MotionReport = {
    name: 'tc-live-dot',
    tagName: 'TC-LIVE-DOT',
    id: '',
    classes: [],
    pseudoElement: null,
  };

  it('names each endless animation once and says what to do about it', () => {
    const message = endlessAnimationsMessage([dot, dot]);
    expect(message).toContain('cannot be finished: tc-live-dot on tc-live-dot. ');
    expect(message).toContain('animation: none');
  });

  it('names what finish() refused', () => {
    expect(refusedAnimationsMessage([{ ...dot, reason: 'still running after finish()' }])).toBe(
      'finishAnimations: finish() did not end: tc-live-dot on tc-live-dot (still running after finish()).',
    );
  });

  it('names the pass cap and the last animations finished', () => {
    expect(restlessAnimationsMessage([dot], 20)).toContain('for 20 passes');
    expect(restlessAnimationsMessage([dot], 20)).toContain(
      'the last pass finished: tc-live-dot on tc-live-dot.',
    );
  });

  it('names the scan cap and what moved during the last scan', () => {
    const message = movedDuringScanMessage([dot], 5);
    expect(message).toContain('each of 5 scans');
    expect(message).toContain('the last scan saw: tc-live-dot on tc-live-dot.');
  });
});
