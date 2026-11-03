import { NOT_SNOOZED, isSnoozeActive, isSnoozeDto, type SnoozeDto } from './snooze';

const NOW = Date.parse('2026-10-05T12:00:00Z');

describe('isSnoozeDto', () => {
  it.each<SnoozeDto>([
    NOT_SNOOZED,
    {
      snoozed: true,
      until: '2026-10-05T13:00:00.000Z',
      allowsUrgent: true,
      since: '2026-10-05T12:00:00.000Z',
    },
    { snoozed: true, until: null, allowsUrgent: false, since: '2026-10-05T12:00:00.000Z' },
  ])('accepts %j', (value) => {
    expect(isSnoozeDto(value)).toBe(true);
  });

  it.each([
    null,
    'snoozed',
    {},
    { snoozed: 'yes' },
    { snoozed: true, until: null, allowsUrgent: true },
    { snoozed: true, until: 'soon', allowsUrgent: true, since: '2026-10-05T12:00:00Z' },
    { snoozed: true, until: null, allowsUrgent: 1, since: '2026-10-05T12:00:00Z' },
  ])('refuses %j', (value) => {
    expect(isSnoozeDto(value)).toBe(false);
  });
});

describe('isSnoozeActive', () => {
  const since = '2026-10-05T11:00:00Z';

  it('is off without a snooze or when not snoozed', () => {
    expect(isSnoozeActive(undefined, NOW)).toBe(false);
    expect(isSnoozeActive(NOT_SNOOZED, NOW)).toBe(false);
  });

  it('mutes until turned back on, and until a time still ahead', () => {
    expect(isSnoozeActive({ snoozed: true, until: null, allowsUrgent: true, since }, NOW)).toBe(true);
    expect(
      isSnoozeActive({ snoozed: true, until: '2026-10-05T12:00:01Z', allowsUrgent: true, since }, NOW),
    ).toBe(true);
  });

  it('stops muting once until has passed, with no other read', () => {
    expect(
      isSnoozeActive({ snoozed: true, until: '2026-10-05T12:00:00Z', allowsUrgent: true, since }, NOW),
    ).toBe(false);
  });
});
