import { isOnConsoleTracker } from './project-tracker';

describe('isOnConsoleTracker', () => {
  it('is true for a project in cutover or on the console tracker', () => {
    expect(isOnConsoleTracker({ tracker: 'console' })).toBe(true);
    expect(isOnConsoleTracker({ tracker: 'cutover' })).toBe(true);
  });

  it('is false for a GitHub project, one without a tracker and one not known', () => {
    expect(isOnConsoleTracker({ tracker: 'github' })).toBe(false);
    expect(isOnConsoleTracker({})).toBe(false);
    expect(isOnConsoleTracker(undefined)).toBe(false);
    expect(isOnConsoleTracker(null)).toBe(false);
  });
});
