import { intlLocaleOf } from '@console/shared/i18n';

/** A Monday: the weekday names are read from the week that starts on it. */
const A_MONDAY = Date.UTC(2024, 0, 1);
const DAY_MS = 86_400_000;

export interface WeekdayName {
  /** «Пн» / «Mon». */
  readonly short: string;
  /** «понедельник» / «Monday», for the column header's `abbr`. */
  readonly long: string;
}

/** Month and weekday names for a console language, all from `Intl` (#307 spec §8: none of them are in the catalogue). */
export interface CalendarNames {
  /** Monday first. */
  readonly weekdays: readonly WeekdayName[];
  /** «Октябрь 2026» / «October 2026» for any day of the month. */
  readonly month: (day: string) => string;
  /** «пятница, 16 октября 2026 г.» / «Friday 16 October 2026»: a day cell's accessible name. */
  readonly fullDay: (day: string) => string;
  readonly todayMark: string;
  readonly unavailable: string;
}

function utcDateOf(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}

function capitalised(text: string, locale: string): string {
  return text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);
}

/**
 * Builds the names once per opened calendar. `todayMark` and `unavailable` are the catalogue's words (already
 * translated by the caller), the rest is `Intl`, so a new language needs no new month list.
 */
export function calendarNamesOf(lang: string, words: { todayMark: string; unavailable: string }): CalendarNames {
  const locale = intlLocaleOf(lang);
  const shortWeekday = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
  const longWeekday = new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' });
  // The month alone is the standalone (nominative) form in Russian: «октябрь», not «октября».
  const monthName = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' });
  const fullDay = new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const weekdays = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(A_MONDAY + index * DAY_MS);
    return {
      short: capitalised(shortWeekday.format(date).replace(/\.$/, ''), locale),
      long: longWeekday.format(date),
    };
  });
  return {
    weekdays,
    month: (day) => `${capitalised(monthName.format(utcDateOf(day)), locale)} ${day.slice(0, 4)}`,
    fullDay: (day) => fullDay.format(utcDateOf(day)),
    todayMark: words.todayMark,
    unavailable: words.unavailable,
  };
}
