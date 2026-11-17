import { isTeamStatePaused } from './team-state.repo';

describe('isTeamStatePaused', () => {
  it('is true for any pause, whoever by', () => {
    expect(isTeamStatePaused({ pausedAt: '2026-11-17T10:00:00.000Z' })).toBe(true);
  });

  it('is false while nothing paused it', () => {
    expect(isTeamStatePaused({ pausedAt: null })).toBe(false);
  });
});
