import { localDayOf, localTimeOf } from '@console/shared/i18n';

/** The four choices of the design: an hour, until 9:00, a week, or until turned back on. */
export type SnoozeOption = 'hour' | 'morning' | 'week' | 'forever';

export const SNOOZE_OPTIONS: readonly SnoozeOption[] = ['hour', 'morning', 'week', 'forever'];

/** "Until morning" is the next 9:00 on the device's clock — the only zone the client knows. */
export const SNOOZE_MORNING_HOUR = 9;
const HOUR_MS = 60 * 60 * 1000;
const WEEK_DAYS = 7;

function atMorning(day: Date, addDays: number): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + addDays, SNOOZE_MORNING_HOUR);
}

/**
 * The `until` the Worker gets for an option, as ISO 8601 UTC; `null` for "until turned back on". Local calendar
 * arithmetic (not `+ 24 h`), so a daylight-saving change still lands on 9:00.
 */
export function snoozeUntilOf(option: SnoozeOption, now: Date): string | null {
  switch (option) {
    case 'hour':
      return new Date(now.getTime() + HOUR_MS).toISOString();
    case 'morning': {
      const today = atMorning(now, 0);
      return (today.getTime() > now.getTime() ? today : atMorning(now, 1)).toISOString();
    }
    case 'week':
      return atMorning(now, WEEK_DAYS).toISOString();
    case 'forever':
      return null;
  }
}

/** `today 13:00`, `tomorrow 09:00`, `12 October, 09:00` — the key and params of `commands.snooze.when.*`. */
export function snoozeWhenOf(
  until: string,
  lang: string,
  nowMs: number,
): { key: string; params: Record<string, string> } {
  const date = new Date(until);
  const time = localTimeOf(date, lang);
  const now = new Date(nowMs);
  const sameDay = (a: Date, b: Date): boolean =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(date, now)) {
    return { key: 'commands.snooze.when.today', params: { time } };
  }
  if (sameDay(date, new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1))) {
    return { key: 'commands.snooze.when.tomorrow', params: { time } };
  }
  return { key: 'commands.snooze.when.date', params: { day: localDayOf(date, lang), time } };
}
