import { BUDGET_PAUSER } from '@shared/contracts';
import { FAILURE_STREAK_PAUSER } from '@worker/db';
import { teamStateOf } from './console-team-state';

const AT = '2026-11-17T09:00:00.000Z';

describe('teamStateOf', () => {
  it('is running while nothing is paused, whatever paused_by still says', () => {
    expect(teamStateOf({ pausedAt: null, pausedBy: null })).toEqual({ state: 'running', pausedAt: null });
    expect(teamStateOf({ pausedAt: null, pausedBy: BUDGET_PAUSER })).toEqual({
      state: 'running',
      pausedAt: null,
    });
  });

  it('names the budget stop, the failure streak, and any other pauser as the owner', () => {
    expect(teamStateOf({ pausedAt: AT, pausedBy: BUDGET_PAUSER })).toEqual({
      state: 'paused-by-budget',
      pausedAt: AT,
    });
    expect(teamStateOf({ pausedAt: AT, pausedBy: FAILURE_STREAK_PAUSER })).toEqual({
      state: 'paused-by-team',
      pausedAt: AT,
    });
    expect(teamStateOf({ pausedAt: AT, pausedBy: 'owner@example.com' })).toEqual({
      state: 'paused-by-owner',
      pausedAt: AT,
    });
    expect(teamStateOf({ pausedAt: AT, pausedBy: null })).toEqual({ state: 'paused-by-owner', pausedAt: AT });
  });
});
