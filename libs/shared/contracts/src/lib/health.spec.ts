import { ENVIRONMENTS, isEnvironment } from './health';

describe('isEnvironment', () => {
  it.each(ENVIRONMENTS)('accepts %s', (environment) => {
    expect(isEnvironment(environment)).toBe(true);
  });

  it('rejects anything that is not one of the four environments', () => {
    expect(isEnvironment('prod')).toBe(false);
    expect(isEnvironment('')).toBe(false);
    expect(isEnvironment(undefined)).toBe(false);
    expect(isEnvironment(1)).toBe(false);
  });
});
