import { pyJsonDumps } from './python-json';
import { OWNER_RESUME, PAUSE_MARKER } from './run-state';

/** The label `runlog pause` sets and `runlog resume` removes; every scheduled run exits while it is on. */
export const PAUSED_LABEL = 'team:paused';
export const RUN_LOG_LABEL = 'team:run-log';

/** What a console pause records: keys `runlog pause --record-file` accepts (a JSON object). */
export interface ConsolePauseRecord {
  readonly reason: string;
  readonly source: 'team-console';
}

/** Python's `datetime.now(timezone.utc).isoformat(timespec="minutes")`: `2026-10-01T13:52+00:00`. */
export function isoMinutes(nowMs: number): string {
  return `${new Date(nowMs).toISOString().slice(0, 16)}+00:00`;
}

/** `owner_pause_marker`: the record as `json.dumps(record, sort_keys=True)` inside the marker. */
export function ownerPauseMarker(record: ConsolePauseRecord): string {
  return `<!-- pt-owner-pause ${pyJsonDumps({ reason: record.reason, source: record.source }, true)} -->`;
}

/** The comment `runlog pause --record-file F [--reason R]` posts, byte for byte. */
export function pauseCommentBody(record: ConsolePauseRecord, nowMs: number): string {
  return (
    `${PAUSE_MARKER}\n${ownerPauseMarker(record)}\n` +
    `**Development paused by the owner** ${isoMinutes(nowMs)}. ${record.reason}\n\n` +
    'Scheduled runs do no work until the owner resumes (say so in the project chat, or comment `/resume`).'
  );
}

/** The comment `runlog resume` posts, byte for byte. */
export function resumeCommentBody(nowMs: number): string {
  return `${OWNER_RESUME}\n**Development resumed** ${isoMinutes(nowMs)}.`;
}

/**
 * The console's slots and the slot names the team's routines write into the run log (`runlog start slot-dev`).
 * Planning is `slot-pm`, development `slot-dev`, QA `slot-qa` (architect note on #114).
 */
export const RUN_LOG_SLOTS = { pm: 'slot-pm', dev: 'slot-dev', qa: 'slot-qa' } as const;
