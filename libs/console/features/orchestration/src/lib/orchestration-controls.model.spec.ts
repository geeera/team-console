import { idleOrchestrationFixture, runningOrchestrationFixture } from '@console/entities/orchestration';
import { controlsViewOf, type ControlsInput } from './orchestration-controls.model';

const base: ControlsInput = {
  status: 'ready',
  run: idleOrchestrationFixture(),
  availability: 'ready',
  isPending: false,
};

describe('controlsViewOf', () => {
  it('offers Start with no run', () => {
    expect(controlsViewOf(base)).toEqual({
      action: 'start',
      isBusy: false,
      isOff: false,
      reasonKey: null,
      stateKey: 'orchestration.state.idle',
      stateParams: { steps: '0', max: '20' },
    });
  });

  it.each([
    ['running', runningOrchestrationFixture({ steps: 3 }), 'orchestration.state.running'],
    [
      'waiting for the owner',
      runningOrchestrationFixture({ state: 'waiting-owner', liveStepId: null, steps: 3 }),
      'orchestration.state.waitingOwner',
    ],
  ])('offers Stop while the run is %s, with its step count', (_name, run, stateKey) => {
    const view = controlsViewOf({ ...base, run });
    expect(view.action).toBe('stop');
    expect(view.isOff).toBe(false);
    expect(view.stateKey).toBe(stateKey);
    expect(view.stateParams).toEqual({ steps: '3', max: '20' });
  });

  it('holds Stop while the run is already stopping', () => {
    const view = controlsViewOf({ ...base, run: runningOrchestrationFixture({ state: 'stopping' }) });
    expect(view.action).toBe('stop');
    expect(view.isOff).toBe(true);
    expect(view.stateKey).toBe('orchestration.state.stopping');
  });

  it('holds Start with a visible reason when no runner serves the project', () => {
    const view = controlsViewOf({ ...base, availability: 'none' });
    expect(view.isOff).toBe(true);
    expect(view.reasonKey).toBe('orchestration.reason.noRunner');
  });

  it('never holds Stop for no runner: Stop is server-side', () => {
    const view = controlsViewOf({ ...base, run: runningOrchestrationFixture(), availability: 'none' });
    expect(view.action).toBe('stop');
    expect(view.isOff).toBe(false);
    expect(view.reasonKey).toBeNull();
  });

  it.each(['offline', 'paused', 'team-paused', null] as const)(
    'keeps Start pressable with availability %s: the job waits, or the Worker words the refusal',
    (availability) => {
      const view = controlsViewOf({ ...base, availability });
      expect(view.isOff).toBe(false);
      expect(view.reasonKey).toBeNull();
    },
  );

  it('is busy and off while the first read is on its way', () => {
    const view = controlsViewOf({ ...base, status: 'loading', run: null });
    expect(view).toMatchObject({ action: 'start', isBusy: true, isOff: true });
    expect(view.stateKey).toBe('orchestration.state.loading');
  });

  it('is busy and off while a command is on its way', () => {
    const view = controlsViewOf({ ...base, run: runningOrchestrationFixture(), isPending: true });
    expect(view).toMatchObject({ action: 'stop', isBusy: true, isOff: true });
  });

  it('offers Start after a failed first read, saying the state is unknown', () => {
    const view = controlsViewOf({ ...base, status: 'error', run: null });
    expect(view).toMatchObject({ action: 'start', isBusy: false, isOff: false });
    expect(view.stateKey).toBe('orchestration.state.unknown');
  });
});
