import { calendarNamesOf } from './calendar-names';
import {
  addMonths,
  clampDay,
  daysInMonth,
  endOfMonth,
  endOfWeek,
  firstAvailableFrom,
  formatTypedDay,
  isMonthOutOfBounds,
  isOutOfBounds,
  localTodayOf,
  monthGridOf,
  parseTypedDay,
  startOfMonth,
  startOfWeek,
  weekdayIndexOf,
} from './date-math';

const OPEN = { min: null, max: null };

describe('date math', () => {
  it('counts the days of a month, leap years included', () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2026, 10)).toBe(31);
    expect(daysInMonth(2026, 11)).toBe(30);
  });

  it('starts weeks on Monday', () => {
    expect(weekdayIndexOf('2026-10-12')).toBe(0); // Monday
    expect(weekdayIndexOf('2026-10-18')).toBe(6); // Sunday
    expect(startOfWeek('2026-10-16')).toBe('2026-10-12');
    expect(endOfWeek('2026-10-16')).toBe('2026-10-18');
    // A week across a month and a year boundary.
    expect(startOfWeek('2027-01-01')).toBe('2026-12-28');
    expect(endOfWeek('2026-12-30')).toBe('2027-01-03');
  });

  it('finds the first and last day of a month', () => {
    expect(startOfMonth('2026-10-16')).toBe('2026-10-01');
    expect(endOfMonth('2028-02-03')).toBe('2028-02-29');
  });

  it('adds months, clamping the day to the target month', () => {
    expect(addMonths('2026-10-16', 1)).toBe('2026-11-16');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-03-31', -1)).toBe('2028-02-29');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
    expect(addMonths('2026-01-15', -1)).toBe('2025-12-15');
    expect(addMonths('2026-10-16', -12)).toBe('2025-10-16');
    expect(addMonths('2028-02-29', 12)).toBe('2029-02-28');
  });

  it('lays a month out Monday first with blank cells around it', () => {
    const october = monthGridOf('2026-10-16');
    expect(october.every((week) => week.length === 7)).toBe(true);
    // 1 October 2026 is a Thursday.
    expect(october[0]).toEqual([null, null, null, '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']);
    expect(october.at(-1)).toEqual([
      '2026-10-26',
      '2026-10-27',
      '2026-10-28',
      '2026-10-29',
      '2026-10-30',
      '2026-10-31',
      null,
    ]);
    expect(october.flat().filter((day) => day !== null)).toHaveLength(31);
    // February 2027 starts on a Monday and fills exactly four weeks.
    expect(monthGridOf('2027-02-10')).toHaveLength(4);
  });

  it('clamps and checks days against open or closed bounds', () => {
    const bounds = { min: '2026-10-08', max: '2026-10-29' };
    expect(clampDay('2026-10-01', bounds)).toBe('2026-10-08');
    expect(clampDay('2026-11-01', bounds)).toBe('2026-10-29');
    expect(clampDay('2026-10-16', bounds)).toBe('2026-10-16');
    expect(clampDay('1999-01-01', OPEN)).toBe('1999-01-01');
    expect(isOutOfBounds('2026-10-07', bounds)).toBe(true);
    expect(isOutOfBounds('2026-10-08', bounds)).toBe(false);
    expect(isOutOfBounds('2026-10-30', bounds)).toBe(true);
  });

  it('says when a whole month is out of bounds', () => {
    const bounds = { min: '2026-10-08', max: '2026-11-03' };
    expect(isMonthOutOfBounds('2026-09-30', bounds)).toBe(true);
    expect(isMonthOutOfBounds('2026-10-01', bounds)).toBe(false);
    expect(isMonthOutOfBounds('2026-11-30', bounds)).toBe(false);
    expect(isMonthOutOfBounds('2026-12-01', bounds)).toBe(true);
  });

  it('finds the first day that can be picked', () => {
    const weekend = (day: string): boolean => weekdayIndexOf(day) >= 5;
    expect(firstAvailableFrom('2026-10-17', weekend)).toBe('2026-10-19');
    expect(firstAvailableFrom('2026-10-16', weekend)).toBe('2026-10-16');
    expect(firstAvailableFrom('2026-10-16', () => true)).toBe('2026-10-16');
  });

  it("reads today from the device's own calendar", () => {
    expect(localTodayOf(new Date(2026, 9, 8, 23, 59))).toBe('2026-10-08');
    expect(localTodayOf(new Date(2026, 0, 1, 0, 0))).toBe('2026-01-01');
  });

  describe('typed days', () => {
    it('formats a day as DD.MM.YYYY', () => {
      expect(formatTypedDay('2026-10-16')).toBe('16.10.2026');
      expect(formatTypedDay('2026-01-05')).toBe('05.01.2026');
    });

    it.each([
      ['16.10.2026', '2026-10-16'],
      ['16/10/2026', '2026-10-16'],
      ['16-10-2026', '2026-10-16'],
      ['16 10 2026', '2026-10-16'],
      ['  5.1.2026 ', '2026-01-05'],
      ['2026-10-16', '2026-10-16'],
      ['29.02.2028', '2028-02-29'],
    ])('reads %j as %s', (text, day) => {
      expect(parseTypedDay(text)).toBe(day);
    });

    it.each([
      '',
      '31.02.2026',
      '29.02.2026',
      '16.13.2026',
      '00.10.2026',
      '16.10.26',
      '2026-13-01',
      'завтра',
      '16.10.2026x',
    ])('refuses %j', (text) => {
      expect(parseTypedDay(text)).toBeNull();
    });
  });
});

describe('calendar names', () => {
  const words = { todayMark: 'сегодня', unavailable: 'недоступно' };

  it('gives Monday-first weekday names and the month in Russian from Intl', () => {
    const names = calendarNamesOf('ru', words);
    expect(names.weekdays.map((weekday) => weekday.short)).toEqual([
      'Пн',
      'Вт',
      'Ср',
      'Чт',
      'Пт',
      'Сб',
      'Вс',
    ]);
    expect(names.weekdays[0]?.long).toBe('понедельник');
    expect(names.month('2026-10-16')).toBe('Октябрь 2026');
    expect(names.fullDay('2026-10-16')).toBe('пятница, 16 октября 2026 г.');
  });

  it('gives the English names from Intl', () => {
    const names = calendarNamesOf('en', { todayMark: 'today', unavailable: 'unavailable' });
    expect(names.weekdays.map((weekday) => weekday.short)).toEqual([
      'Mon',
      'Tue',
      'Wed',
      'Thu',
      'Fri',
      'Sat',
      'Sun',
    ]);
    expect(names.month('2026-10-16')).toBe('October 2026');
    expect(names.fullDay('2026-10-16')).toMatch(/Friday,? 16 October 2026/);
  });
});
