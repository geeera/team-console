import { TEAM_SLOTS, isTeamSlot } from './team';

describe('isTeamSlot', () => {
  it.each(TEAM_SLOTS)('accepts %s', (slot) => {
    expect(isTeamSlot(slot)).toBe(true);
  });

  it.each(['slot-dev', 'DEV', '', null, 1, 'burn'])('refuses %j', (value) => {
    expect(isTeamSlot(value)).toBe(false);
  });
});
