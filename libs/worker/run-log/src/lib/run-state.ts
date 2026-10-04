/**
 * A port of the plugin's `scripts/ptlib/runstate.py` (vendored in `.claude/product-team`): the run-log markers,
 * how a run's entries merge, when a `started` run counts as dead, the overlap and failure-streak decision, and the
 * active owner pause. `fixtures/generate.py` runs the plugin itself over the cases the spec replays here, so the
 * console never reads the log differently from the team.
 */

/** A run-log comment as the REST API returns it, narrowed to what the run state reads. */
export interface RunLogComment {
  readonly id: number;
  readonly body: string;
  /** ISO 8601 as GitHub sends it; `null` when absent. */
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  /** `user.login`; empty for a deleted account. */
  readonly author: string;
}

export type RunState = 'started' | 'finished' | 'failed' | 'unknown' | (string & {});

export interface Run {
  readonly id: string;
  readonly slot: string;
  readonly state: RunState;
  /** The first trusted entry's time (the start). */
  readonly at: string | null;
  readonly commentId: number;
  readonly metrics: Readonly<Record<string, unknown>>;
  readonly acted: readonly (readonly [number, number])[];
  readonly trusted: boolean;
  readonly finishedAt: string | null;
}

export type Decision = 'paused' | 'overlap' | 'pause' | 'proceed';

export interface DecideResult {
  readonly decision: Decision;
  readonly reason: string;
  /** The run in progress behind an `overlap`. */
  readonly runId?: string;
}

export const PAUSE_MARKER = '<!-- pt-paused -->';
export const OWNER_RESUME = '<!-- pt-owner-resume -->';
export const FAILURE_LIMIT = 3;
/** `runstate.OVERLAP_WINDOW`: a `started` run older than this died. */
export const OVERLAP_WINDOW_MS = 3 * 60 * 60 * 1000;
export const UNKNOWN = 'unknown';
const FINAL: ReadonlySet<string> = new Set(['finished', 'failed']);

const MARKER = /<!-- pt-run id=(\S+) slot=(\S+) state=(\S+) -->/;
const OWNER_PAUSE = /<!-- pt-owner-pause (\{[\s\S]*?\}) -->/;
const METRICS = /<!-- pt-metrics (\{.*?\}) -->/;
const ACTED = /<!-- pt-acted (\[.*?\]) -->/;

interface Entry {
  readonly id: string;
  readonly slot: string;
  readonly state: string;
  readonly at: string | null;
  readonly commentId: number;
  readonly metrics: Readonly<Record<string, unknown>>;
  readonly acted: readonly (readonly [number, number])[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The run log is a public thread: a malformed block must not stop anything (`_metrics_of`). */
function metricsOf(body: string): Readonly<Record<string, unknown>> {
  const match = METRICS.exec(body);
  const value = match?.[1] === undefined ? undefined : parseJson(match[1]);
  return isRecord(value) ? value : {};
}

function actedOf(body: string): readonly (readonly [number, number])[] {
  const match = ACTED.exec(body);
  const value = match?.[1] === undefined ? undefined : parseJson(match[1]);
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (pair): pair is [number, number] =>
      Array.isArray(pair) && pair.length === 2 && pair.every((x) => Number.isInteger(x)),
  );
}

const byAt = <T extends { readonly at: string | null }>(a: T, b: T): number => {
  const left = a.at ?? '';
  const right = b.at ?? '';
  return left < right ? -1 : left > right ? 1 : 0;
};

function entriesOf(comments: readonly RunLogComment[]): Entry[] {
  const found: Entry[] = [];
  for (const comment of comments) {
    const match = MARKER.exec(comment.body);
    if (match !== null) {
      found.push({
        id: match[1] ?? '',
        slot: match[2] ?? '',
        state: match[3] ?? '',
        at: comment.createdAt,
        commentId: comment.id,
        metrics: metricsOf(comment.body),
        acted: actedOf(comment.body),
      });
    }
  }
  return found.sort(byAt);
}

/**
 * `parse_runs`: one run per id, oldest first, from trusted entries only — `at` and `slot` from the first,
 * `state`, `commentId`, `metrics`, `acted` and `finishedAt` from the latest. An untrusted entry that postdates a
 * run's latest trusted entry only marks the run `trusted: false`.
 */
export function parseRuns(
  trusted: readonly RunLogComment[],
  untrusted: readonly RunLogComment[] = [],
): Run[] {
  const runs = new Map<string, { run: Run; lastAt: string | null }>();
  for (const entry of entriesOf(trusted)) {
    const finishedAt = FINAL.has(entry.state) ? entry.at : null;
    const known = runs.get(entry.id);
    if (known === undefined) {
      runs.set(entry.id, { run: { ...entry, trusted: true, finishedAt }, lastAt: null });
    } else {
      known.run = {
        ...known.run,
        state: entry.state,
        commentId: entry.commentId,
        metrics: entry.metrics,
        acted: entry.acted,
        finishedAt,
      };
      known.lastAt = entry.at;
    }
  }
  for (const entry of entriesOf(untrusted)) {
    const known = runs.get(entry.id);
    if (known !== undefined && (entry.at ?? '') >= (known.lastAt ?? known.run.at ?? '')) {
      known.run = { ...known.run, trusted: false };
    }
  }
  return [...runs.values()].map((known) => known.run).sort(byAt);
}

/** Python's `datetime.fromisoformat` for GitHub's and the plugin's timestamps; `NaN` when unreadable. */
export function timeOf(value: string | null): number {
  return value === null ? Number.NaN : Date.parse(value);
}

/**
 * `effective_state`: a `started` run older than the overlap window died (usually on the usage limit) and counts
 * as failed; a run an untrusted entry postdates is `unknown` once it ended, and still in progress while `started`.
 */
export function effectiveState(run: Run, nowMs: number): RunState {
  if (run.state === 'started') {
    return nowMs - timeOf(run.at) >= OVERLAP_WINDOW_MS ? 'failed' : 'started';
  }
  return run.trusted ? run.state : UNKNOWN;
}

/** `decide`: what `runlog start <slot>` would answer now. `resetAt`: the owner's last resume. */
export function decide(
  runs: readonly Run[],
  slot: string,
  nowMs: number,
  paused: boolean,
  resetAt = '',
): DecideResult {
  if (paused) {
    return { decision: 'paused', reason: 'run log is paused; owner must comment /resume' };
  }
  for (const run of [...runs].reverse()) {
    if (run.slot === slot && effectiveState(run, nowMs) === 'started') {
      return {
        decision: 'overlap',
        reason: `run ${run.id} of slot ${slot} is still in progress`,
        runId: run.id,
      };
    }
  }
  const finished = runs.filter((run) => (run.at ?? '') > resetAt).map((run) => effectiveState(run, nowMs));
  const tail = finished.filter((state) => state !== 'started').slice(-FAILURE_LIMIT);
  if (tail.length === FAILURE_LIMIT && tail.every((state) => state === 'failed')) {
    return { decision: 'pause', reason: `last ${FAILURE_LIMIT} runs failed` };
  }
  return { decision: 'proceed', reason: '' };
}

export interface OwnerPause {
  readonly record: Readonly<Record<string, unknown>>;
  /** The record's comment time (`paused_at` in the plugin's output). */
  readonly pausedAt: string;
}

/** `active_owner_pause`: the latest owner pause record not resumed since, or `null`. */
export function activeOwnerPause(comments: readonly RunLogComment[]): OwnerPause | null {
  let latest: Record<string, unknown> | null = null;
  let latestAt = '';
  let resumedAt = '';
  for (const comment of comments) {
    const at = comment.createdAt ?? '';
    const match = OWNER_PAUSE.exec(comment.body);
    if (match?.[1] !== undefined && at >= latestAt) {
      const value = parseJson(match[1]);
      if (!isRecord(value)) {
        // json.loads failed: the plugin skips the rest of this comment, its resume marker included.
        continue;
      }
      latest = value;
      latestAt = at;
    }
    if (comment.body.includes(OWNER_RESUME) && at > resumedAt) {
      resumedAt = at;
    }
  }
  if (latest === null || resumedAt > latestAt) {
    return null;
  }
  return { record: latest, pausedAt: latestAt };
}
