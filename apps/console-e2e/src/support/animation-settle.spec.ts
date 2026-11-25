import { describe, expect, it } from 'vitest';
import {
  type AnimationReport,
  restartingAnimationsMessage,
  type SettleAnimation,
  type SettleEnv,
  type SettleOptions,
  settleRound,
  stuckAnimationsMessage,
} from './animation-settle';

// A real round caps at 3 s; small numbers keep the timed cases fast.
const OPTIONS: SettleOptions = { quietFrames: 4, maxWaitMs: 300, slackMs: 20 };

interface FakeAnimation extends SettleAnimation {
  playState: string;
  finish(): void;
  cancel(): void;
}

function fakeAnimation(
  init: {
    readonly name?: string;
    readonly playState?: string;
    readonly iterations?: number;
    readonly endTime?: number;
    readonly localTime?: number;
    readonly target?: {
      readonly tagName: string;
      readonly id?: string;
      readonly classes?: readonly string[];
    } | null;
  } = {},
): FakeAnimation {
  let resolveFinished: (value: unknown) => void = () => undefined;
  let rejectFinished: (reason: unknown) => void = () => undefined;
  const finished = new Promise<unknown>((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });
  const target =
    init.target === null
      ? null
      : {
          tagName: init.target?.tagName ?? 'DIV',
          id: init.target?.id ?? '',
          classList: [...(init.target?.classes ?? [])],
        };
  const animation: FakeAnimation = {
    id: '',
    playState: init.playState ?? 'running',
    playbackRate: 1,
    finished,
    animationName: init.name ?? 'm-enter',
    effect: {
      getComputedTiming: () => ({
        iterations: init.iterations ?? 1,
        endTime: init.endTime ?? 240,
        localTime: init.localTime ?? 0,
      }),
      target,
      pseudoElement: null,
    },
    finish: () => {
      animation.playState = 'finished';
      resolveFinished(undefined);
    },
    cancel: () => {
      animation.playState = 'idle';
      rejectFinished(new DOMException('cancelled', 'AbortError'));
    },
  };
  return animation;
}

/** A page whose animations list is `live`, read fresh each time, with a frame per microtask turn. */
function env(live: () => readonly SettleAnimation[], onFrame: () => void = () => undefined): SettleEnv {
  return {
    animations: live,
    nextFrame: async () => {
      onFrame();
      await Promise.resolve();
    },
  };
}

describe('settleRound', () => {
  it('is quiet when nothing runs for the required frames', async () => {
    let frames = 0;
    const result = await settleRound(
      OPTIONS,
      env(
        () => [],
        () => frames++,
      ),
    );
    expect(result).toEqual({ quiet: true });
    expect(frames).toBe(OPTIONS.quietFrames);
  });

  it('ignores endless and paused animations (a hovered Undo toast hairline never finishes while paused)', async () => {
    const spinner = fakeAnimation({ name: 'tc-spin', iterations: Infinity });
    const hairline = fakeAnimation({ name: 'tc-toast-undo-run', playState: 'paused', endTime: 10_000 });
    const result = await settleRound(
      OPTIONS,
      env(() => [spinner, hairline]),
    );
    expect(result).toEqual({ quiet: true });
  });

  it('waits for a running animation to finish and reports it as seen, not stuck', async () => {
    const fade = fakeAnimation({ target: { tagName: 'TC-OVERVIEW-PAGE' } });
    setTimeout(() => fade.finish(), 10);
    const result = await settleRound(
      OPTIONS,
      env(() => (fade.playState === 'running' ? [fade] : [])),
    );
    expect(result).toEqual({
      quiet: false,
      running: [{ name: 'm-enter', target: 'tc-overview-page', remainingMs: 240 }],
      stuck: [],
    });
  });

  it('counts an animation cancelled mid-way (AbortError) as settled', async () => {
    const roll = fakeAnimation({ name: 'tc-roll-out' });
    setTimeout(() => roll.cancel(), 10);
    const result = await settleRound(
      OPTIONS,
      env(() => (roll.playState === 'running' ? [roll] : [])),
    );
    expect(result.quiet).toBe(false);
    expect(!result.quiet && result.stuck).toEqual([]);
  });

  it('names component keyframes without the Angular scope prefix', async () => {
    const meter = fakeAnimation({
      name: '_ngcontent-ng-c689207796_tc-meter-fill',
      endTime: 900,
      target: { tagName: 'I', classes: ['tc-meter__fill'] },
    });
    const result = await settleRound(
      OPTIONS,
      env(() => [meter]),
    );
    expect(!result.quiet && result.stuck).toEqual([
      { name: 'tc-meter-fill', target: 'i.tc-meter__fill', remainingMs: 900 },
    ]);
  });

  it('reports an animation that outlives its budget instead of waiting for it', async () => {
    // Claims 100 ms left but never ends: the budget is 100 + slack, well under the test's own timeout.
    const stalled = fakeAnimation({
      name: 'tc-sheet-rise',
      endTime: 300,
      localTime: 200,
      target: { tagName: 'DIV', id: 'sheet', classes: ['tc-sheet', 'tc-sheet--open'] },
    });
    const started = Date.now();
    const result = await settleRound(
      OPTIONS,
      env(() => [stalled]),
    );
    expect(Date.now() - started).toBeLessThan(OPTIONS.maxWaitMs);
    expect(result).toEqual({
      quiet: false,
      running: [{ name: 'tc-sheet-rise', target: 'div#sheet.tc-sheet.tc-sheet--open', remainingMs: 100 }],
      stuck: [{ name: 'tc-sheet-rise', target: 'div#sheet.tc-sheet.tc-sheet--open', remainingMs: 100 }],
    });
  });

  it('fails at once on an animation with more time left than the per-animation cap', async () => {
    const hairline = fakeAnimation({
      name: 'tc-toast-undo-run',
      endTime: 10_000,
      localTime: 1_000,
      target: { tagName: 'SPAN', classes: ['tc-toast__bar'] },
    });
    const started = Date.now();
    const result = await settleRound(
      OPTIONS,
      env(() => [hairline]),
    );
    expect(Date.now() - started).toBeLessThan(50);
    expect(!result.quiet && result.stuck).toEqual([
      { name: 'tc-toast-undo-run', target: 'span.tc-toast__bar', remainingMs: 9_000 },
    ]);
  });

  it('caps the wait when the remaining time cannot be read', async () => {
    const unknown = fakeAnimation({ target: null });
    Object.assign(unknown, {
      effect: { getComputedTiming: () => ({ iterations: 1, endTime: 240, localTime: null }), target: null },
    });
    const started = Date.now();
    const result = await settleRound(
      OPTIONS,
      env(() => [unknown]),
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(OPTIONS.maxWaitMs - 5);
    expect(!result.quiet && result.stuck).toEqual([
      { name: 'm-enter', target: '(no target)', remainingMs: null },
    ]);
  });

  it('is not quiet when an animation starts during the quiet frames', async () => {
    const late = fakeAnimation();
    let frames = 0;
    setTimeout(() => late.finish(), 10);
    const result = await settleRound(
      OPTIONS,
      env(
        () => (frames >= 2 && late.playState === 'running' ? [late] : []),
        () => frames++,
      ),
    );
    expect(result.quiet).toBe(false);
  });
});

describe('failure messages', () => {
  const stuck: AnimationReport[] = [
    { name: 'tc-toast-undo-run', target: 'span.tc-toast__bar', remainingMs: 8_999.6 },
    { name: 'transition: opacity', target: 'div#x', remainingMs: null },
  ];

  it('names each stuck animation, its element and the time it had left', () => {
    const message = stuckAnimationsMessage(stuck, 3000);
    expect(message).toContain('at most 3000 ms each');
    expect(message).toContain('tc-toast-undo-run on span.tc-toast__bar (9000 ms left)');
    expect(message).toContain('transition: opacity on div#x (time left unknown)');
  });

  it('names the last animations seen when the page kept starting new ones', () => {
    expect(restartingAnimationsMessage(stuck.slice(0, 1), 20)).toBe(
      'animationsSettled: animations kept starting for 20 rounds; last seen: tc-toast-undo-run on span.tc-toast__bar (9000 ms left).',
    );
    expect(restartingAnimationsMessage([], 20)).toContain('none named');
  });
});
