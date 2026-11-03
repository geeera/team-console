import { localCalendarDayOf, localCalendarRangeOf, localDayOf, localNumberOf, localTimeOf } from './local-time';

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

describe('localCalendarDayOf / localCalendarRangeOf (#218)', () => {
  it('formats a calendar day without moving it to the reader time zone', () => {
    expect(localCalendarDayOf('2026-10-14', 'ru')).toBe('14 октября');
    expect(localCalendarDayOf('2026-10-14', 'en')).toBe('14 October');
    expect(localCalendarDayOf('14.10.2026', 'ru')).toBe('');
  });

  it('formats a range of calendar days, both included', () => {
    expect(localCalendarRangeOf('2026-10-12', '2026-10-14', 'ru')).toMatch(/^12\s?–\s?14 октября$/);
    expect(localCalendarRangeOf('2026-09-30', '2026-10-02', 'en')).toMatch(/^30 September\s?–\s?2 October$/);
    expect(localCalendarRangeOf('2026-10-14', '2026-10-14', 'en')).toBe('14 October');
    expect(localCalendarRangeOf('', '2026-10-14', 'en')).toBe('');
  });
});
