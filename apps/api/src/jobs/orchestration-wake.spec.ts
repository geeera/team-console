import { ORCHESTRATE_MAX_STEPS } from '@shared/contracts';
import { stepNextOf, wakeDecisionOf, type WakeDecision, type WakeInput } from './orchestration-wake';

// #1039 (ADR 0010 decision 1): the wake is a pure decision over the run's rows; the routes apply it
// (orchestration.spec.ts proves the finish path end to end).

const RUN = '01M6YSNJ00000000000000RR01';
const finishedWith = (next: unknown): Readonly<Record<string, unknown>> => ({
  summary: 'step',
  metrics: { next },
  acted: true,
});
const BASE: WakeInput = {
  runId: RUN,
  steps: 1,
  liveStep: false,
  liveChildren: 0,
  lastStepResult: finishedWith('children'),
  paused: false,
};

describe('wakeDecisionOf', () => {
  it.each<[string, Partial<WakeInput>, WakeDecision]>([
    ['an idle project (no run)', { runId: null }, 'end-run'],
    ['a live step', { liveStep: true }, 'wait-children'],
    ['live children', { liveChildren: 2 }, 'wait-children'],
    ['a live step while paused', { liveStep: true, paused: true }, 'wait-children'],
    ['live children at the cap', { liveChildren: 1, steps: ORCHESTRATE_MAX_STEPS }, 'wait-children'],
    ['a pause with nothing live', { paused: true }, 'paused'],
    ['a pause after next: done', { paused: true, lastStepResult: finishedWith('done') }, 'paused'],
    ['next: children', {}, 'enqueue-step'],
    ['next: review', { lastStepResult: finishedWith('review') }, 'enqueue-step'],
    ['next: owner', { lastStepResult: finishedWith('owner') }, 'wait-owner'],
    ['next: done', { lastStepResult: finishedWith('done') }, 'end-run'],
    [
      'next: done at the cap',
      { lastStepResult: finishedWith('done'), steps: ORCHESTRATE_MAX_STEPS },
      'end-run',
    ],
    ['an unknown next', { lastStepResult: finishedWith('merge-everything') }, 'enqueue-step'],
    ['a next that is no string', { lastStepResult: finishedWith(7) }, 'enqueue-step'],
    ['a step result without metrics', { lastStepResult: { reason: 'owner-cancelled' } }, 'enqueue-step'],
    ['no step result yet', { lastStepResult: null }, 'enqueue-step'],
    ['one step under the cap', { steps: ORCHESTRATE_MAX_STEPS - 1 }, 'enqueue-step'],
    ['the cap (20 steps, owner decision 2026-11-26)', { steps: ORCHESTRATE_MAX_STEPS }, 'cap'],
    ['past the cap', { steps: ORCHESTRATE_MAX_STEPS + 3 }, 'cap'],
    [
      'next: owner at the cap',
      { lastStepResult: finishedWith('owner'), steps: ORCHESTRATE_MAX_STEPS },
      'cap',
    ],
  ])('%s → %s', (_, input, decision) => {
    expect(wakeDecisionOf({ ...BASE, ...input })).toBe(decision);
  });

  it('caps at 20', () => {
    expect(ORCHESTRATE_MAX_STEPS).toBe(20);
    expect(wakeDecisionOf({ ...BASE, steps: 19 })).toBe('enqueue-step');
    expect(wakeDecisionOf({ ...BASE, steps: 20 })).toBe('cap');
  });
});

describe('stepNextOf', () => {
  it('reads metrics.next as one of the four values, anything else as children', () => {
    expect(stepNextOf(finishedWith('review'))).toBe('review');
    expect(stepNextOf(finishedWith(null))).toBe('children');
    expect(stepNextOf({ metrics: 'done' })).toBe('children');
    expect(stepNextOf(null)).toBe('children');
  });
});
