/**
 * Sprint commands (#29 slice 1, #218): move the current sprint's demo date and start the next sprint, written as
 * the plugin's `backlog sprint create` writes milestones. Days are calendar days (`YYYY-MM-DD`) of the plugin's
 * calendar, Europe/Kyiv (`ptlib.calendar.KYIV`), whatever the reader's time zone.
 */

/** The plugin's calendar zone: "today", "past" and the freeze are computed here. */
export const SPRINT_TIME_ZONE = 'Europe/Kyiv';

/** `sprint.freeze_days` when project.yml does not set a usable one (the plugin's default). */
export const DEFAULT_FREEZE_DAYS = 2;

/** The largest `sprint.freeze_days` the console reads; a larger value is a typo, not a freeze. */
export const MAX_FREEZE_DAYS = 14;

/** The next sprint's default demo: two weeks after the current one (or after today without one). */
export const NEXT_SPRINT_DEFAULT_DAYS = 14;

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A real calendar day written `YYYY-MM-DD` (no 2026-02-30). */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const match = CALENDAR_DATE.exec(value);
  if (match === null) {
    return false;
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** `YYYY-MM-DD` of `nowMs` in the sprint calendar's zone. */
export function calendarDayOf(nowMs: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: SPRINT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(nowMs));
}

/** The calendar day `days` after `day` (before it when negative); `day` must be a calendar date. */
export function addDays(day: string, days: number): string {
  const [year = 0, month = 1, date = 1] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date) + days * DAY_MS).toISOString().slice(0, 10);
}

/** First and last day of a freeze, both inclusive. */
export interface SprintFreezeDto {
  readonly from: string;
  readonly to: string;
}

/**
 * `calendar.freeze_window`: stage is cut `freezeDays` before the demo and the freeze lasts through demo day, so a
 * demo on the 14th with two freeze days freezes the 12th to the 14th.
 */
export function freezeOf(due: string, freezeDays: number): SprintFreezeDto {
  return { from: addDays(due, -freezeDays), to: due };
}

export function isInFreeze(day: string, freeze: SprintFreezeDto): boolean {
  return freeze.from <= day && day <= freeze.to;
}

/** `Sprint 07`: the title `backlog sprint create` is given by the PM, two digits at least. */
export function sprintTitleOf(number: number): string {
  return `Sprint ${String(number).padStart(2, '0')}`;
}

const SPRINT_TITLE = /^Sprint (\d{1,4})$/;

/** The number of a `Sprint NN` title; `null` for any other milestone title. */
export function sprintNumberOf(title: string): number | null {
  const match = SPRINT_TITLE.exec(title.trim());
  return match === null ? null : Number(match[1]);
}

/** A sprint as the commands name it: milestone number, title, demo day. */
export interface SprintRefDto {
  readonly number: number;
  readonly title: string;
  /** The demo day, `YYYY-MM-DD`. */
  readonly due: string;
}

/** The current sprint on the status card: its demo, its freeze and the next sprint when one exists. */
export interface TeamSprintDto extends SprintRefDto {
  readonly freeze: SprintFreezeDto;
  /** The open sprint whose demo comes next after this one; "Start the next sprint" is not offered while it exists. */
  readonly next: SprintRefDto | null;
}

/** Work issues of the current sprint: done (closed with `status:done`) of all, as the board counts them. */
export interface SprintProgressDto {
  readonly done: number;
  readonly total: number;
}

/** What the sprint forms need to pre-validate a date the way the Worker will. */
export interface SprintCalendarDto {
  /** Today in the sprint calendar's zone. */
  readonly today: string;
  /** `sprint.freeze_days` of project.yml. */
  readonly freezeDays: number;
  /** The title "Start the next sprint" would create (highest `Sprint NN`, open or closed, + 1). */
  readonly nextTitle: string;
}

/** `POST /api/v1/projects/:slug/sprint/demo-date`. */
export interface MoveDemoRequest {
  readonly due: string;
  /** The demo day the owner saw; another live one is 409 `sprint-changed`. */
  readonly expectedDue: string;
}

export interface MoveDemoResponse {
  readonly sprint: SprintRefDto;
  readonly freeze: SprintFreezeDto;
  /** Today is inside the new freeze: no new issues are taken from the next run on. */
  readonly freezeStartsNow: boolean;
}

/** `POST /api/v1/projects/:slug/sprint/next`. */
export interface NextSprintRequest {
  readonly due: string;
  /** The current sprint's title the owner saw, `null` for "no current sprint". */
  readonly expectedCurrent: string | null;
}

export interface NextSprintResponse {
  readonly sprint: SprintRefDto;
  /** The current demo after which the new sprint becomes current; `null` when it is current already. */
  readonly becomesCurrentAfter: string | null;
}

/**
 * The problem `type` slugs of the sprint commands, with their (flat) extension members:
 * `sprint-none` (no current sprint to move), `sprint-changed` (`due`, or `currentTitle` / `currentDue`: the live
 * values to refill the form with), `sprint-unchanged` (the date is the current one), `sprint-exists` (`nextTitle`,
 * `nextDue`: the next sprint is there already; `nextDue` is `null` when GitHub refused a duplicate title), `sprint-date-past`, `sprint-date-after-next` (`nextTitle`, `nextDue`),
 * `sprint-date-early` (`after`: the day the demo must come after).
 */
export type SprintProblemType =
  | 'sprint-none'
  | 'sprint-changed'
  | 'sprint-unchanged'
  | 'sprint-exists'
  | 'sprint-date-past'
  | 'sprint-date-after-next'
  | 'sprint-date-early';
