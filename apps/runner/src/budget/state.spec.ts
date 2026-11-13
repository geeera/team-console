import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stateAfter } from '../jobs/loop';
import { EMPTY_STATE, activePause, loadRunnerState, saveRunnerState, type RunnerState } from './state';

/** ADR 0008 decision 9: the local pause survives a restart; the back-off resets after a success. */

describe('state.json', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'tcr-state-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const paused: RunnerState = {
    schema: 1,
    pause: { reason: 'usage-limit', until: '2026-11-13T13:00:00.000Z' },
    limitStreak: 2,
  };

  it('starts empty and keeps a pause across a restart, 0600', async () => {
    await expect(loadRunnerState(home)).resolves.toEqual(EMPTY_STATE);
    await saveRunnerState(home, paused);
    await saveRunnerState(home, paused);
    await expect(loadRunnerState(home)).resolves.toEqual(paused);
    expect((await stat(join(home, 'state.json'))).mode & 0o777).toBe(0o600);
  });

  it('refuses a state file it cannot trust instead of dropping the pause', async () => {
    await writeFile(join(home, 'state.json'), '{"schema":1,"pause":{"reason":"manual"},"limitStreak":0}', {
      mode: 0o600,
    });
    await expect(loadRunnerState(home)).rejects.toMatchObject({ problem: 'config-invalid' });
    await writeFile(join(home, 'state.json'), 'not json', { mode: 0o600 });
    await expect(loadRunnerState(home)).rejects.toMatchObject({ problem: 'config-invalid' });
    await writeFile(join(home, 'state.json'), JSON.stringify(EMPTY_STATE));
    await chmod(join(home, 'state.json'), 0o644);
    await expect(loadRunnerState(home)).rejects.toMatchObject({ problem: 'file-unsafe' });
  });

  it('holds a pause until its time', () => {
    expect(activePause(paused, new Date('2026-11-13T12:59:59.000Z'))).toEqual(paused.pause);
    expect(activePause(paused, new Date('2026-11-13T13:00:00.000Z'))).toBeNull();
  });

  it('pauses and counts on a limit, resets after a success, keeps the streak on another failure', () => {
    const limit = {
      result: 'failed' as const,
      reason: 'rate-limit',
      limit: { reason: 'rate-limit' as const, retryAt: '2026-11-13T14:00:00.000Z' },
    };
    expect(stateAfter(paused, limit)).toEqual({
      schema: 1,
      pause: { reason: 'rate-limit', until: '2026-11-13T14:00:00.000Z' },
      limitStreak: 3,
    });
    expect(stateAfter(paused, { result: 'finished', reason: null, limit: null })).toEqual(EMPTY_STATE);
    expect(stateAfter(paused, { result: 'failed', reason: 'exit', limit: null })).toEqual({
      ...paused,
      pause: null,
    });
  });
});
