import type { TestInfo } from '@playwright/test';

/**
 * The browser context's time zone, as the Playwright config sets it (`use.timezoneId`). The app and the plugin count
 * days in that zone, while the Node process runs in the runner's (UTC on CI), so a spec must never derive a day from
 * Node's own clock: the two disagree on the date for hours every evening (#981, #991).
 */
export function contextTimeZone(info: TestInfo): string {
  const timeZone = info.project.use.timezoneId;
  if (timeZone === undefined) {
    throw new Error(
      'playwright.config sets no use.timezoneId, so the browser day is the machine day: set one.',
    );
  }
  return timeZone;
}

/** The calendar day `days` from `now` in `timeZone`, as `YYYY-MM-DD`. Calendar arithmetic, so a DST change cannot move it. */
export function dayFromToday(timeZone: string, days: number, now: Date = new Date()): string {
  const [year, month, day] = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(now)
    .split('-')
    .map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`Cannot read the calendar day in ${timeZone}.`);
  }
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** `days` from today in the browser context's time zone: the day the page itself calls today plus `days`. */
export function contextDay(info: TestInfo, days: number): string {
  return dayFromToday(contextTimeZone(info), days);
}

/**
 * The instant a wall clock in `timeZone` shows `time` (`HH:MM`) on `day` (`YYYY-MM-DD`). The zone's offset is read at
 * that instant, so a day on either side of a DST change gets its own. A time the clocks skip or repeat is not handled.
 */
export function instantInZone(day: string, time: string, timeZone: string): Date {
  const asUtc = new Date(`${day}T${time}:00Z`);
  const offsetAt = (instant: Date): number => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(instant);
    const part = (type: Intl.DateTimeFormatPartTypes): number =>
      Number(parts.find((candidate) => candidate.type === type)?.value);
    const wall = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
    return wall - instant.getTime();
  };
  // Two passes: the first guess may sit on the other side of a DST change than the answer.
  const first = new Date(asUtc.getTime() - offsetAt(asUtc));
  return new Date(asUtc.getTime() - offsetAt(first));
}
