import {
  RUN_ENTRY_STATES,
  TEAM_RUN_STATES,
  TEAM_SLOTS,
  isRunEntryState,
  isTeamRunState,
  isTeamSlot,
} from './team';

describe('isTeamSlot', () => {
  it.each(TEAM_SLOTS)('accepts %s', (slot) => {
    expect(isTeamSlot(slot)).toBe(true);
  });

  it.each(['slot-dev', 'DEV', '', null, 1, 'burn'])('refuses %j', (value) => {
    expect(isTeamSlot(value)).toBe(false);
  });
});

describe('isTeamRunState', () => {
  it.each(TEAM_RUN_STATES)('accepts %s', (state) => {
    expect(isTeamRunState(state)).toBe(true);
  });

  it.each(['paused-by-owner', 'Running', '', null, 0, 'failed'])('refuses %j', (value) => {
    expect(isTeamRunState(value)).toBe(false);
  });
});

describe('isRunEntryState', () => {
  it.each(RUN_ENTRY_STATES)('accepts %s', (state) => {
    expect(isRunEntryState(state)).toBe(true);
  });

  it.each(['started', 'FAILED', '', null, 1, 'failing'])('refuses %j', (value) => {
    expect(isRunEntryState(value)).toBe(false);
  });
});
