import { SPRINT_CI_STATES, isSprintCiState } from './read-models';

describe('isSprintCiState', () => {
  it.each(SPRINT_CI_STATES)('accepts %s', (state) => {
    expect(isSprintCiState(state)).toBe(true);
  });

  it.each([['neutral'], ['SUCCESS'], [''], [null], [undefined], [1]])('rejects %j', (value) => {
    expect(isSprintCiState(value)).toBe(false);
  });
});
