import { addDays, isCalendarDate } from '@shared/contracts';

/**
 * Calendar-day math for the `DatePicker` (#307). A day is an ISO calendar day (`YYYY-MM-DD`), the value shape the
 * picker reads and writes; every computation runs in UTC, so no time zone ever moves a day.
 */

/** The range a picker accepts, both ends inclusive; `null` leaves that side open. */
export interface DayBounds {
  readonly min: string | null;
  readonly max: string | null;
}

interface DayParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function partsOf(day: string): DayParts {
  const [year = 1970, month = 1, date = 1] = day.split('-').map(Number);
  return { year, month, day: date };
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, '0');
}

/** `YYYY-MM-DD` of a real date; the caller makes sure the parts are one. */
function dayOf(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 0 for Monday through 6 for Sunday: the console's weeks start on Monday (ru and en-GB alike). */
export function weekdayIndexOf(day: string): number {
  const { year, month, day: date } = partsOf(day);
  return (new Date(Date.UTC(year, month - 1, date)).getUTCDay() + 6) % 7;
}

export function startOfWeek(day: string): string {
  return addDays(day, -weekdayIndexOf(day));
}

export function endOfWeek(day: string): string {
  return addDays(day, 6 - weekdayIndexOf(day));
}

export function startOfMonth(day: string): string {
  const { year, month } = partsOf(day);
  return dayOf(year, month, 1);
}

export function endOfMonth(day: string): string {
  const { year, month } = partsOf(day);
  return dayOf(year, month, daysInMonth(year, month));
}

/** The same day `months` later (earlier when negative), clamped to the target month's length: 31 Jan + 1 = 28/29 Feb. */
export function addMonths(day: string, months: number): string {
  const { year, month, day: date } = partsOf(day);
  const index = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(index / 12);
  const targetMonth = index - targetYear * 12 + 1;
  return dayOf(targetYear, targetMonth, Math.min(date, daysInMonth(targetYear, targetMonth)));
}

export function isSameMonth(a: string, b: string): boolean {
  return a.slice(0, 7) === b.slice(0, 7);
}

/** `day` moved into the bounds; ISO days compare as strings. */
export function clampDay(day: string, bounds: DayBounds): string {
  if (bounds.min !== null && day < bounds.min) {
    return bounds.min;
  }
  if (bounds.max !== null && day > bounds.max) {
    return bounds.max;
  }
  return day;
}

export function isOutOfBounds(day: string, bounds: DayBounds): boolean {
  return (bounds.min !== null && day < bounds.min) || (bounds.max !== null && day > bounds.max);
}

/**
 * The weeks of `day`'s month, Monday first; the days of the neighbouring months are `null` (blank cells, #307 spec §2),
 * so every row has seven cells.
 */
export function monthGridOf(day: string): (string | null)[][] {
  const first = startOfMonth(day);
  const { year, month } = partsOf(first);
  const cells: (string | null)[] = Array.from({ length: weekdayIndexOf(first) }, () => null);
  for (let date = 1; date <= daysInMonth(year, month); date += 1) {
    cells.push(dayOf(year, month, date));
  }
  while (cells.length % 7 !== 0) {
    cells.push(null);
  }
  const weeks: (string | null)[][] = [];
  for (let start = 0; start < cells.length; start += 7) {
    weeks.push(cells.slice(start, start + 7));
  }
  return weeks;
}

/** Whether a whole month lies outside the bounds, so its prev/next button is off. */
export function isMonthOutOfBounds(day: string, bounds: DayBounds): boolean {
  return (
    (bounds.max !== null && startOfMonth(day) > bounds.max) ||
    (bounds.min !== null && endOfMonth(day) < bounds.min)
  );
}

/** The reader's own calendar day: "today" in the picker is the day on the device's clock. */
export function localTodayOf(now: Date): string {
  return dayOf(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

/** `16.10.2026`: the typed form of a day in both ru and en (#307 spec §1). */
export function formatTypedDay(day: string): string {
  const { year, month, day: date } = partsOf(day);
  return `${pad(date, 2)}.${pad(month, 2)}.${pad(year, 4)}`;
}

const ISO_DAY = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
/** Day, month and a four-digit year with `.`, `/`, `-` or spaces between them. */
const TYPED_DAY = /^(\d{1,2})\s*[./\-\s]\s*(\d{1,2})\s*[./\-\s]\s*(\d{4})$/;

/** What the owner typed as a calendar day, or `null` when it is not a real date (`31.02.2026`, `16.10.26`, words). */
export function parseTypedDay(text: string): string | null {
  const trimmed = text.trim();
  const iso = ISO_DAY.exec(trimmed);
  const typed = iso === null ? TYPED_DAY.exec(trimmed) : null;
  const parts =
    iso !== null
      ? { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) }
      : typed !== null
        ? { year: Number(typed[3]), month: Number(typed[2]), day: Number(typed[1]) }
        : null;
  if (parts === null) {
    return null;
  }
  const day = dayOf(parts.year, parts.month, parts.day);
  return isCalendarDate(day) ? day : null;
}

/** The first day from `day` on that can be picked, looking a year ahead; `day` itself when none can. */
export function firstAvailableFrom(day: string, isUnavailable: (day: string) => boolean): string {
  let candidate = day;
  for (let step = 0; step <= 366; step += 1) {
    if (!isUnavailable(candidate)) {
      return candidate;
    }
    candidate = addDays(candidate, 1);
  }
  return day;
}
