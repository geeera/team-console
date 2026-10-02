import type { Run } from '@worker/run-log';
import type { RunLogView } from './run-log-reader';
import { overviewTeamStateOf } from './team-health';

const NOW = Date.parse('2026-10-01T12:00:00Z');
const at = (minutesAgo: number): string => new Date(NOW - minutesAgo * 60_000).toISOString();

function runOf(id: string, state: string, minutesAgo: number): Run {
  return {
    id,
    slot: 'slot-dev',
    state,
    at: at(minutesAgo),
    commentId: 1,
    metrics: {},
    acted: [],
    trusted: true,
    finishedAt: state === 'started' ? null : at(minutesAgo),
  };
}

function view(overrides: Partial<RunLogView>): RunLogView {
  return {
    issue: null,
    runs: [],
    ownerPause: null,
    paused: false,
    state: 'running',
    pausedSince: '',
    ownerResumeAt: '',
    ...overrides,
  };
}

const threeFailed = [runOf('a', 'failed', 90), runOf('b', 'failed', 60), runOf('c', 'failed', 40)];

describe('overviewTeamStateOf', () => {
  it('is running with no run log yet', () => {
    expect(overviewTeamStateOf(view({}), NOW)).toBe('running');
  });

  it('is paused while the owner paused it, failing while the team paused itself', () => {
    const ownerPause = { record: {}, pausedAt: at(30) };
    expect(overviewTeamStateOf(view({ paused: true, ownerPause, pausedSince: at(30) }), NOW)).toBe('paused');
    expect(overviewTeamStateOf(view({ paused: true, runs: threeFailed, pausedSince: at(30) }), NOW)).toBe(
      'failing',
    );
  });

  it('is failing on three failed runs in a row, before the next start writes the pause', () => {
    expect(overviewTeamStateOf(view({ runs: threeFailed }), NOW)).toBe('failing');
  });

  it('counts a run started over three hours ago as failed, as runstate does', () => {
    const runs = [runOf('a', 'failed', 400), runOf('b', 'failed', 300), runOf('c', 'started', 200)];
    expect(overviewTeamStateOf(view({ runs }), NOW)).toBe('failing');
  });

  it('is running again after a pause or resume, or a finished run, breaks the streak', () => {
    expect(overviewTeamStateOf(view({ runs: threeFailed, pausedSince: at(30) }), NOW)).toBe('running');
    expect(overviewTeamStateOf(view({ runs: threeFailed, ownerResumeAt: at(30) }), NOW)).toBe('running');
    expect(overviewTeamStateOf(view({ runs: [...threeFailed, runOf('d', 'finished', 10)] }), NOW)).toBe(
      'running',
    );
  });

  it("lifts the team's own pause once the owner commented /resume after it", () => {
    const paused = { paused: true, runs: threeFailed, pausedSince: at(30) };
    expect(overviewTeamStateOf(view({ ...paused, ownerResumeAt: at(10) }), NOW)).toBe('running');
    expect(overviewTeamStateOf(view({ ...paused, ownerResumeAt: at(50) }), NOW)).toBe('failing');
  });
});
