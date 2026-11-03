import { HttpErrorResponse } from '@angular/common/http';
import { httpProblemOf } from '@console/shared/api';

/**
 * How a team command ended when it did not do what was asked, shared by every command of the Commands panel (#114
 * pause / resume / Run now, #218 sprint commands, #219 requests to the PM): the client branches on the problem `type` only. Lives with the
 * team status so each command feature uses one mapping instead of forking it.
 */

/** Which project a command is for: its slug and the name the owner reads. */
export interface CommandTarget {
  readonly slug: string;
  readonly name: string;
}

/**
 * The result note at the top of the panel (a margin note, like an answered card): moss when done, grey when nothing
 * changed, ochre when nobody knows yet whether the run started.
 */
export interface CommandOutcome {
  readonly tone: 'positive' | 'neutral' | 'warning';
  readonly verb: string;
  readonly detail: string | null;
  /** The run log, where the owner checks what happened. */
  readonly runLogUrl: string | null;
  /** ISO 8601. */
  readonly at: string;
}

/** Why a command did not do what was asked, as the panel words it. Each maps to `commands.*` copy. */
export type CommandFailureKind =
  // nothing changed: the run log already says so
  | 'already-paused'
  | 'not-paused'
  | 'run-in-progress'
  | 'run-requested'
  // nobody knows yet
  | 'routine-unknown'
  // refused, the dialog stays open
  | 'rate-limited'
  | 'routine-paused'
  | 'bad-token'
  | 'bad-routine'
  | 'not-configured'
  | 'run-paused'
  | 'service'
  | 'github'
  | 'github-rate-limited'
  | 'not-connected'
  | 'no-run-log'
  | 'pause-unreliable'
  // sprint commands (#218): the live milestones disagree with the form
  | 'sprint-none'
  | 'sprint-changed'
  | 'sprint-unchanged'
  | 'sprint-exists'
  | 'sprint-date-past'
  | 'sprint-date-after-next'
  | 'sprint-date-early'
  // owner requests to the PM (#219)
  | 'issue-changed'
  | 'issue-closed'
  | 'request-not-issue'
  | 'sprint-next-missing'
  | 'request-in-progress'
  | 'offline'
  | 'unknown';

export interface CommandFailure {
  readonly kind: CommandFailureKind;
  /** Seconds from `Retry-After`, when the answer carried one. */
  readonly retryAfter: number | null;
  /** Still untrusted: read with `textOf`. */
  readonly extensions: Readonly<Record<string, unknown>>;
}

export type CommandResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: CommandFailure };

const BY_PROBLEM: Readonly<Record<string, CommandFailureKind>> = {
  'team-already-paused': 'already-paused',
  'team-not-paused': 'not-paused',
  'team-command-in-progress': 'github',
  'run-in-progress': 'run-in-progress',
  'run-requested': 'run-requested',
  'routine-unknown': 'routine-unknown',
  'routine-rate-limited': 'rate-limited',
  'routine-paused': 'routine-paused',
  'routine-unavailable': 'service',
  'run-paused': 'run-paused',
  'run-log-missing': 'no-run-log',
  'pause-unreliable': 'pause-unreliable',
  'sprint-none': 'sprint-none',
  'sprint-changed': 'sprint-changed',
  'sprint-unchanged': 'sprint-unchanged',
  'sprint-exists': 'sprint-exists',
  'sprint-date-past': 'sprint-date-past',
  'sprint-date-after-next': 'sprint-date-after-next',
  'sprint-date-early': 'sprint-date-early',
  'issue-changed': 'issue-changed',
  'issue-closed': 'issue-closed',
  'request-not-issue': 'request-not-issue',
  'sprint-next-missing': 'sprint-next-missing',
  'request-in-progress': 'request-in-progress',
  'github-owner-not-connected': 'not-connected',
  'github-owner-mismatch': 'not-connected',
  'github-rate-limit': 'github-rate-limited',
  'github-unavailable': 'github',
  'github-unexpected': 'github',
  'github-auth': 'github',
};

/** A string extension member, or `null` (the client never assumes a problem's shape). */
export function textOf(failure: CommandFailure, name: string): string | null {
  const value = failure.extensions[name];
  return typeof value === 'string' ? value : null;
}

/** The failure behind an error of a command request; branches on the problem `type` only. */
export function commandFailureOf(error: unknown): CommandFailure {
  if (!(error instanceof HttpErrorResponse)) {
    return { kind: 'unknown', retryAfter: null, extensions: {} };
  }
  const problem = httpProblemOf(error);
  if (problem.status === 0) {
    return { kind: 'offline', retryAfter: null, extensions: {} };
  }
  let kind: CommandFailureKind = (problem.slug !== null ? BY_PROBLEM[problem.slug] : undefined) ?? 'unknown';
  if (problem.slug === 'routine-not-configured') {
    const step = problem.extensions['step'];
    kind = step === 'token' ? 'bad-token' : step === 'routine' ? 'bad-routine' : 'not-configured';
  }
  return { kind, retryAfter: problem.retryAfterSeconds, extensions: problem.extensions };
}
