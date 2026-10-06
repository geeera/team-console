/**
 * Snoozed notifications per project (#221, architect note on #29 §5): one project's pushes muted on every device of
 * the owner until a time or until turned back on, urgent ones still delivered unless the owner said otherwise.
 * Stored in D1 only; nothing is written to GitHub.
 */

/** The longest snooze with an end the Worker accepts; "until turned back on" has no end. */
export const SNOOZE_MAX_DAYS = 31;

/** `PUT /api/v1/projects/:slug/notifications/snooze`. */
export interface SnoozeRequest {
  /** ISO 8601 with a zone, in the future and at most `SNOOZE_MAX_DAYS` away; `null` = until turned back on. */
  readonly until: string | null;
  /** Urgent pushes still arrive: the team paused itself, a release is ready, a question on a `team:demo` issue. */
  readonly allowsUrgent: boolean;
}

/** A project's snooze as the Worker reads it now: an expired one is `{ snoozed: false }`. */
export type SnoozeDto =
  | { readonly snoozed: false }
  | {
      readonly snoozed: true;
      /** ISO 8601 UTC; `null` = until turned back on. */
      readonly until: string | null;
      readonly allowsUrgent: boolean;
      /** ISO 8601 UTC: when the owner snoozed. */
      readonly since: string;
    };

export const NOT_SNOOZED: SnoozeDto = { snoozed: false };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTime(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/** Narrows an answer of the Worker; the client renders no snooze it did not check. */
export function isSnoozeDto(value: unknown): value is SnoozeDto {
  if (!isRecord(value)) {
    return false;
  }
  if (value['snoozed'] === false) {
    return true;
  }
  return (
    value['snoozed'] === true &&
    (value['until'] === null || isTime(value['until'])) &&
    typeof value['allowsUrgent'] === 'boolean' &&
    isTime(value['since'])
  );
}

/**
 * Whether the snooze still mutes at `nowMs`. The Worker answers with what was true when it read; a page left open
 * past `until` stops showing it without another read.
 */
export function isSnoozeActive(snooze: SnoozeDto | undefined, nowMs: number): boolean {
  return (
    snooze !== undefined && snooze.snoozed && (snooze.until === null || Date.parse(snooze.until) > nowMs)
  );
}
