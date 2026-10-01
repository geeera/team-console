import { localDayOf, localTimeOf } from './local-time';

describe('localTimeOf / localDayOf', () => {
  // A local wall-clock time, so the expectation does not depend on the runner's time zone.
  const at = new Date(2026, 8, 28, 13, 5);

  it('formats a time and a day in ru and en', () => {
    expect(localTimeOf(at, 'ru')).toBe('13:05');
    expect(localTimeOf(at, 'en')).toBe('13:05');
    expect(localDayOf(at, 'ru')).toBe('28 сентября');
    expect(localDayOf(at, 'en')).toBe('28 September');
  });

  it('reads ISO strings and gives an empty string for an unreadable value', () => {
    expect(localTimeOf(at.toISOString(), 'ru')).toBe('13:05');
    expect(localTimeOf('not a date', 'ru')).toBe('');
    expect(localDayOf('', 'en')).toBe('');
  });
});
