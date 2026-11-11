import type { IconName } from '@console/shared/ui';
import { withoutInvisibles } from '@shared/plain-text';
import type { JobDto, JobEventDto, JobKind, JobState } from '@shared/contracts';

/**
 * The kinds Run now offers (#464, ADR 0008 row 2-E): the ones `POST …/jobs` runs from the kind alone. `review` needs
 * items and a role, `chat` a message, `kickoff` and `import` belong to a project's start and its cutover, so the
 * picker leaves them to the flows that carry their payload.
 */
export const RUN_NOW_KINDS = [
  'slot-pm',
  'slot-dev',
  'slot-qa',
  'burn',
  'audit',
  'digest',
] as const satisfies readonly JobKind[];
export type RunNowKind = (typeof RUN_NOW_KINDS)[number];

/** A job still in the queue or held by a runner; every other state is final (the 0022 trigger keeps it so). */
export const LIVE_JOB_STATES: readonly JobState[] = ['queued', 'claimed', 'running'];

export function isLiveJob(job: JobDto): boolean {
  return LIVE_JOB_STATES.includes(job.state);
}

/** A runner holds the job (claimed or running): its events are worth reading. */
export function isHeldJob(job: JobDto): boolean {
  return job.state === 'claimed' || job.state === 'running';
}

/** Held jobs first, then the queue in the order it is served (oldest first). */
export function currentJobsOf(jobs: readonly JobDto[]): readonly JobDto[] {
  const byAge = (a: JobDto, b: JobDto): number =>
    a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  return [...jobs.filter(isHeldJob).sort(byAge), ...jobs.filter((job) => job.state === 'queued').sort(byAge)];
}

/** How many ended jobs the view lists under the current ones. */
export const RECENT_JOBS_LIMIT = 5;

/** The jobs that ended, newest first (the Worker lists newest first; ids are ULIDs, so they sort by time). */
export function recentJobsOf(jobs: readonly JobDto[], limit = RECENT_JOBS_LIMIT): readonly JobDto[] {
  return jobs
    .filter((job) => !isLiveJob(job))
    .sort((a, b) => b.id.localeCompare(a.id))
    .slice(0, limit);
}

/**
 * The board's "Run log" tile for a console-tracker project (#464): what the queue says right now.
 * `running` — a runner holds a job; `queued` — jobs wait and none is held; otherwise the newest ended job's outcome
 * (`failed` covers `failed` and `lost`; `cancelled` reads as `finished`, nothing failed), or `none` before any job.
 */
export type JobsTileState = 'running' | 'queued' | 'failed' | 'finished' | 'none';

export interface JobsTile {
  readonly state: JobsTileState;
  /** The kind of the job the state is about; `null` for `none`. */
  readonly kind: JobKind | null;
  /** Jobs in that state: held or queued for the first two, otherwise 1 (or 0 for `none`). */
  readonly count: number;
}

export function jobsTileOf(jobs: readonly JobDto[]): JobsTile {
  const current = currentJobsOf(jobs);
  const held = current.filter(isHeldJob);
  const first = current[0];
  if (held.length > 0 && first !== undefined) {
    return { state: 'running', kind: first.kind, count: held.length };
  }
  if (first !== undefined) {
    return { state: 'queued', kind: first.kind, count: current.length };
  }
  const last = recentJobsOf(jobs, 1)[0];
  if (last === undefined) {
    return { state: 'none', kind: null, count: 0 };
  }
  return {
    state: last.state === 'failed' || last.state === 'lost' ? 'failed' : 'finished',
    kind: last.kind,
    count: 1,
  };
}

/** One glyph per tile state, so the tile reads without its colour. */
export const JOBS_TILE_ICONS: Readonly<Record<JobsTileState, IconName>> = {
  running: 'play',
  queued: 'clock',
  failed: 'alert',
  finished: 'check',
  none: 'minus',
};

/** One glyph per job state. */
export const JOB_STATE_ICONS: Readonly<Record<JobState, IconName>> = {
  queued: 'clock',
  claimed: 'play',
  running: 'play',
  finished: 'check',
  failed: 'x',
  lost: 'alert',
  cancelled: 'minus',
};

/** Runner text is shown as one bounded line of plain text, never markup. */
export const JOB_TEXT_MAX_LENGTH = 500;

function plainLine(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const line = withoutInvisibles(value).replace(/\s+/g, ' ').trim();
  if (line === '') {
    return null;
  }
  return line.length > JOB_TEXT_MAX_LENGTH ? `${line.slice(0, JOB_TEXT_MAX_LENGTH - 1)}…` : line;
}

/** The payload members a runner's event carries its words in, in the order the view prefers them. */
const TEXT_MEMBERS = ['line', 'message', 'summary', 'text', 'reason', 'skill'] as const;

/**
 * The words of one event (#464): its first text member, as plain text for interpolation only. The Worker already ran
 * every string through the shared redactor (loose mode) before it stored it; this only makes it one safe line.
 */
export function jobEventTextOf(event: JobEventDto): string | null {
  for (const member of TEXT_MEMBERS) {
    const line = plainLine(event.payload[member]);
    if (line !== null) {
      return line;
    }
  }
  return null;
}

/** An ended job's summary (`result.summary`), or the Worker's reason (`lost`), as one plain line. */
export function jobSummaryOf(job: JobDto): string | null {
  return plainLine(job.result?.['summary']) ?? plainLine(job.result?.['reason']);
}

/** The runner named by id when the account's runners are known; a short id otherwise (a member cannot list them). */
export function runnerLabelOf(runnerId: string, names: ReadonlyMap<string, string>): string {
  return names.get(runnerId) ?? `…${runnerId.slice(-6)}`;
}
