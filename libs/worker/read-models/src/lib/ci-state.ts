import type { SprintCiState } from '@shared/contracts';

/**
 * A pull request's CI (#131) from `GET /repos/{repo}/commits/{sha}/check-runs?filter=latest`, ported from the
 * plugin's `ptlib/checks.summarise` for check runs: any failed run fails the commit, else any unfinished run keeps
 * it pending, else it passed. Unlike the plugin (which merges in legacy commit statuses and treats "no checks yet"
 * as pending before a merge), a head without any check run reads `none` here: the board only reports.
 */

/** One page of check runs: what the endpoint answers, narrowed to what the state needs. */
export interface CheckRunsPage {
  /** GitHub's count of every check run on the commit, which may exceed the runs of this page. */
  readonly totalCount: number;
  readonly runs: readonly CheckRunRecord[];
}

export interface CheckRunRecord {
  /** `queued`, `in_progress`, `completed`, `waiting`, `requested` or `pending`. */
  readonly status: string;
  /** Set once `completed`; `null` before. */
  readonly conclusion: string | null;
}

/** The plugin's `FAILED`: conclusions that fail a commit. `success`, `neutral` and `skipped` pass. */
export const FAILED_CONCLUSIONS: ReadonlySet<string> = new Set([
  'failure',
  'timed_out',
  'cancelled',
  'action_required',
  'startup_failure',
  'stale',
]);

type JsonRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCheckRun(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value['status'] === 'string' &&
    (value['conclusion'] === null ||
      value['conclusion'] === undefined ||
      typeof value['conclusion'] === 'string')
  );
}

export function isGitHubCheckRunsPage(value: unknown): value is JsonRecord {
  return (
    isRecord(value) &&
    typeof value['total_count'] === 'number' &&
    Number.isSafeInteger(value['total_count']) &&
    value['total_count'] >= 0 &&
    Array.isArray(value['check_runs']) &&
    value['check_runs'].every(isCheckRun)
  );
}

/** Call only on a value `isGitHubCheckRunsPage` accepted. */
export function checkRunsPageOf(raw: JsonRecord): CheckRunsPage {
  const runs = Array.isArray(raw['check_runs']) ? (raw['check_runs'] as unknown[]) : [];
  return {
    totalCount: Number(raw['total_count']),
    runs: runs.filter(isRecord).map((run) => ({
      status: String(run['status']),
      conclusion: typeof run['conclusion'] === 'string' ? run['conclusion'] : null,
    })),
  };
}

export function ciStateOf(page: CheckRunsPage): SprintCiState {
  if (page.runs.length === 0) {
    // A count without runs means GitHub listed none of them on this page: not "no checks".
    return page.totalCount === 0 ? 'none' : 'unknown';
  }
  let pending = false;
  for (const run of page.runs) {
    if (run.status !== 'completed') {
      pending = true;
    } else if (run.conclusion !== null && FAILED_CONCLUSIONS.has(run.conclusion)) {
      return 'failure';
    }
  }
  if (pending) {
    return 'pending';
  }
  // Runs past the first page are unseen; one of them may have failed.
  return page.runs.length < page.totalCount ? 'unknown' : 'success';
}
