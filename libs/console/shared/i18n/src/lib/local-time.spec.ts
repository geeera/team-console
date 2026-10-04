import { localDayOf, localNumberOf, localTimeOf } from './local-time';

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

describe('localNumberOf', () => {
  it('formats a count in ru and en', () => {
    // ru groups thousands with a no-break space, en-GB with a comma; both use the locale's decimal mark.
    expect(localNumberOf(1234, 'ru')).toBe('1\u00a0234');
    expect(localNumberOf(1234, 'en')).toBe('1,234');
    expect(localNumberOf(2.5, 'ru')).toBe('2,5');
    expect(localNumberOf(2.5, 'en')).toBe('2.5');
    expect(localNumberOf(7, 'ru')).toBe('7');
  });

  it('gives an empty string rather than NaN', () => {
    expect(localNumberOf(Number.NaN, 'en')).toBe('');
    expect(localNumberOf(Number.POSITIVE_INFINITY, 'ru')).toBe('');
  });
});
