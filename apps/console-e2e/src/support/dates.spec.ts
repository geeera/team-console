import type { TestInfo } from '@playwright/test';
import { describe, expect, it } from 'vitest';
import { contextTimeZone, dayFromToday } from './dates';

const infoWith = (timezoneId: string | undefined): TestInfo =>
  ({ project: { use: { timezoneId } } }) as unknown as TestInfo;

describe('dayFromToday', () => {
  it('follows the zone, not UTC, late in the UTC evening (22:30 UTC is already tomorrow in Kyiv)', () => {
    const now = new Date('2026-11-25T22:30:00Z');
    expect(dayFromToday('UTC', 0, now)).toBe('2026-11-25');
    expect(dayFromToday('Europe/Kyiv', 0, now)).toBe('2026-11-26');
    expect(dayFromToday('Europe/Kyiv', 1, now)).toBe('2026-11-27');
  });

  it('stays on the same day just after midnight UTC', () => {
    expect(dayFromToday('Europe/Kyiv', 0, new Date('2026-11-26T00:30:00Z'))).toBe('2026-11-26');
  });

  it('counts calendar days across a month and a year end', () => {
    expect(dayFromToday('Europe/Kyiv', 15, new Date('2026-11-25T10:00:00Z'))).toBe('2026-12-10');
    expect(dayFromToday('Europe/Kyiv', 1, new Date('2026-12-31T10:00:00Z'))).toBe('2027-01-01');
  });

  it('is not moved by a DST change inside the span', () => {
    // Kyiv enters summer time on 2026-03-29: +24 h from 23:30 on the 28th would land on the 30th.
    expect(dayFromToday('Europe/Kyiv', 1, new Date('2026-03-28T21:30:00Z'))).toBe('2026-03-29');
    expect(dayFromToday('Europe/Kyiv', 3, new Date('2026-03-27T12:00:00Z'))).toBe('2026-03-30');
  });

  it('goes back in time with a negative offset', () => {
    expect(dayFromToday('Europe/Kyiv', -1, new Date('2026-03-01T10:00:00Z'))).toBe('2026-02-28');
  });
});

describe('contextTimeZone', () => {
  it('reads the zone from the project config', () => {
    expect(contextTimeZone(infoWith('Europe/Kyiv'))).toBe('Europe/Kyiv');
  });

  it('fails loudly when the config sets no zone', () => {
    expect(() => contextTimeZone(infoWith(undefined))).toThrow(/timezoneId/);
  });
});
