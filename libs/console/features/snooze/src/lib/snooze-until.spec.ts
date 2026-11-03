import { snoozeUntilOf, snoozeWhenOf } from './snooze-until';

// Built from local calendar parts, so the cases hold in whatever zone the test runs: the client only knows its own.
const local = (month: number, day: number, hour: number, minute = 0): Date =>
  new Date(2026, month - 1, day, hour, minute);

describe('snoozeUntilOf', () => {
  it('an hour is sixty minutes from now', () => {
    const now = local(10, 5, 14, 30);
    expect(snoozeUntilOf('hour', now)).toBe(new Date(now.getTime() + 3_600_000).toISOString());
  });

  it('until morning is today 9:00 before nine, tomorrow 9:00 from nine on', () => {
    expect(snoozeUntilOf('morning', local(10, 5, 2, 15))).toBe(local(10, 5, 9).toISOString());
    expect(snoozeUntilOf('morning', local(10, 5, 9))).toBe(local(10, 6, 9).toISOString());
    expect(snoozeUntilOf('morning', local(10, 5, 23, 50))).toBe(local(10, 6, 9).toISOString());
  });

  it('crosses a month end on the calendar', () => {
    expect(snoozeUntilOf('morning', local(10, 31, 22))).toBe(local(11, 1, 9).toISOString());
  });

  it('a week is 9:00 seven days on, never past the Worker’s 31-day cap', () => {
    const now = local(10, 5, 14, 30);
    const until = snoozeUntilOf('week', now);
    expect(until).toBe(local(10, 12, 9).toISOString());
    expect(Date.parse(until ?? '') - now.getTime()).toBeLessThan(31 * 24 * 3_600_000);
  });

  it('until turned back on has no end', () => {
    expect(snoozeUntilOf('forever', local(10, 5, 14))).toBeNull();
  });
});

describe('snoozeWhenOf', () => {
  const now = local(10, 5, 14).getTime();

  it('says today, tomorrow, or the date with the time', () => {
    expect(snoozeWhenOf(local(10, 5, 15).toISOString(), 'ru', now)).toEqual({
      key: 'commands.snooze.when.today',
      params: { time: '15:00' },
    });
    expect(snoozeWhenOf(local(10, 6, 9).toISOString(), 'en', now)).toEqual({
      key: 'commands.snooze.when.tomorrow',
      params: { time: '09:00' },
    });
    expect(snoozeWhenOf(local(10, 12, 9).toISOString(), 'ru', now)).toEqual({
      key: 'commands.snooze.when.date',
      params: { day: '12 октября', time: '09:00' },
    });
  });
});
