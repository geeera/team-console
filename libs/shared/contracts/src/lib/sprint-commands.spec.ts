import {
  addDays,
  calendarDayOf,
  freezeOf,
  isCalendarDate,
  isInFreeze,
  sprintNumberOf,
  sprintTitleOf,
} from './sprint-commands';

describe('isCalendarDate', () => {
  it.each(['2026-10-14', '2028-02-29', '2026-12-31'])('accepts %s', (value) => {
    expect(isCalendarDate(value)).toBe(true);
  });

  it.each([
    '2026-02-30',
    '2027-02-29',
    '2026-13-01',
    '2026-10-1',
    '14.10.2026',
    '2026-10-14T12:00:00Z',
    '',
    null,
    20261014,
  ])('refuses %j', (value) => {
    expect(isCalendarDate(value)).toBe(false);
  });
});

describe('calendarDayOf', () => {
  it('is the Kyiv day, not the UTC one', () => {
    // 22:30 UTC on the 13th is 01:30 on the 14th in Kyiv (UTC+3 in October).
    expect(calendarDayOf(Date.parse('2026-10-13T22:30:00Z'))).toBe('2026-10-14');
    expect(calendarDayOf(Date.parse('2026-10-13T20:59:00Z'))).toBe('2026-10-13');
    // Winter time: UTC+2.
    expect(calendarDayOf(Date.parse('2026-12-31T22:00:00Z'))).toBe('2027-01-01');
  });
});

describe('addDays', () => {
  it('crosses months, years and leap days', () => {
    expect(addDays('2026-10-14', 14)).toBe('2026-10-28');
    expect(addDays('2026-10-01', -2)).toBe('2026-09-29');
    expect(addDays('2026-12-25', 14)).toBe('2027-01-08');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('ignores a daylight-saving change (25 October 2026 in Kyiv)', () => {
    expect(addDays('2026-10-24', 2)).toBe('2026-10-26');
  });
});

describe('freezeOf', () => {
  it('starts freeze_days before the demo and lasts through demo day, as calendar.freeze_window', () => {
    expect(freezeOf('2026-10-14', 2)).toEqual({ from: '2026-10-12', to: '2026-10-14' });
    expect(freezeOf('2026-10-14', 0)).toEqual({ from: '2026-10-14', to: '2026-10-14' });
  });

  it('includes both ends', () => {
    const freeze = freezeOf('2026-10-14', 2);
    expect(isInFreeze('2026-10-11', freeze)).toBe(false);
    expect(isInFreeze('2026-10-12', freeze)).toBe(true);
    expect(isInFreeze('2026-10-14', freeze)).toBe(true);
    expect(isInFreeze('2026-10-15', freeze)).toBe(false);
  });
});

describe('sprint titles', () => {
  it('writes two digits at least', () => {
    expect(sprintTitleOf(4)).toBe('Sprint 04');
    expect(sprintTitleOf(12)).toBe('Sprint 12');
    expect(sprintTitleOf(104)).toBe('Sprint 104');
  });

  it.each([
    ['Sprint 03', 3],
    ['Sprint 3', 3],
    [' Sprint 12 ', 12],
  ])('reads %j as %d', (title, number) => {
    expect(sprintNumberOf(title)).toBe(number);
  });

  it.each(['Release 1', 'sprint 03', 'Sprint 03 (hotfix)', 'Sprint', 'Sprint -1', 'Sprint 12345'])(
    'reads %j as no sprint',
    (title) => {
      expect(sprintNumberOf(title)).toBeNull();
    },
  );
});
