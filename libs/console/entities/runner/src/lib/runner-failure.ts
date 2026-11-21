import { HttpErrorResponse } from '@angular/common/http';
import { httpProblemOf, isAccessSessionExpired } from '@console/shared/api';
import { ACTIONS_NOT_READY } from '@shared/contracts';
import { TimeoutError } from 'rxjs';

/**
 * Why a Settings › Runners call did not succeed, as the screens word it (#464):
 * - `forbidden` — 403: the caller is no owner of the account (`account-owner-only`), this identity may not act, or
 *   another owner tried to add projects to a subscription runner (`runner-scope-enroller-only`, #795), or the caller
 *   is not the account's sole owner (`runner-enroller-not-sole-owner`, #827);
 * - `not-found` — 404: the account, runner or project is not the caller's (the same answer as one that is missing);
 * - `invalid` — 422 with the problem slug (`allowed-projects-invalid`, `runner-scope-fixed`, `runner-policy-invalid`, …)
 *   and the field;
 * - `revoked` — 409 `runner-revoked`: someone revoked it meanwhile;
 * - `not-suspect` — 409 `runner-not-suspect`: its suspect mark was cleared meanwhile (#492);
 * - `enroller-set` — 409 `runner-enroller-set`: its enroller was recorded meanwhile (#827);
 * - `conflict` — 409 on an enrolment intent (#634 PR 4): the open-request limit, or the request changed or is not
 *   bound yet; the slug says which;
 * - `rate-limited` — 429; `offline` — no answer; `timeout` — none in `RUNNER_CALL_TIMEOUT_MS`;
 * - `session-expired` — Access wants a new login (the app root takes over); `error` — anything else.
 */
export type RunnerFailureKind =
  | 'forbidden'
  | 'not-found'
  | 'invalid'
  | 'revoked'
  | 'not-suspect'
  | 'enroller-set'
  | 'conflict'
  | 'rate-limited'
  | 'offline'
  | 'timeout'
  | 'session-expired'
  | 'error';

export interface RunnerFailure {
  readonly kind: RunnerFailureKind;
  /** Our problem slug, when the answer was one of our problems. */
  readonly slug: string | null;
  /** The body member a 422 names. */
  readonly field: string | null;
  /** 422 `actions-not-ready` (#759): the readiness items that hold the switch back, as the problem names them. */
  readonly items?: readonly string[];
  /** 429 (#879): seconds from `Retry-After`, `null` when the answer named none. */
  readonly retryAfterSeconds?: number | null;
}

export type RunnerResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: RunnerFailure };

/** A call with no answer in this long is reported as `timeout`. */
export const RUNNER_CALL_TIMEOUT_MS = 20_000;

/** Branches on the status and the problem slug only, never on `title` or `detail`. */
export function runnerFailureOf(error: unknown): RunnerFailure {
  if (error instanceof TimeoutError) {
    return { kind: 'timeout', slug: null, field: null };
  }
  if (!(error instanceof HttpErrorResponse)) {
    return { kind: 'error', slug: null, field: null };
  }
  // Before the status-0 check: Access's redirect arrives as an opaque status 0 while the network works (#367).
  if (isAccessSessionExpired(error, error.error)) {
    return { kind: 'session-expired', slug: null, field: null };
  }
  const problem = httpProblemOf(error);
  const field = typeof problem.extensions['field'] === 'string' ? problem.extensions['field'] : null;
  const failure = (kind: RunnerFailureKind): RunnerFailure =>
    problem.slug === ACTIONS_NOT_READY
      ? { kind, slug: problem.slug, field, items: itemIdsOf(problem.extensions['items']) }
      : { kind, slug: problem.slug, field };
  switch (problem.status) {
    case 0:
      return failure('offline');
    case 403:
      return failure('forbidden');
    case 404:
      return failure('not-found');
    case 409:
      switch (problem.slug) {
        case 'runner-revoked':
          return failure('revoked');
        case 'runner-not-suspect':
          return failure('not-suspect');
        case 'runner-enroller-set':
          return failure('enroller-set');
        case 'enrolment-intent-limit':
        case 'enrolment-intent-changed':
        case 'enrolment-fingerprint-mismatch':
        case 'enrolment-intent-not-bound':
          return failure('conflict');
        default:
          return failure('error');
      }
    case 413:
    case 422:
      return failure('invalid');
    case 429:
      return { ...failure('rate-limited'), retryAfterSeconds: problem.retryAfterSeconds };
    default:
      return failure('error');
  }
}

/**
 * The `runners.err.*` key that explains a failure: one table for every Settings › Runners screen, so a refusal
 * reads the same in the list, the enrolment dialog and the policy editor.
 */
export function runnerFailureKeyOf(failure: RunnerFailure): string {
  if (failure.kind === 'invalid') {
    switch (failure.slug) {
      case 'allowed-projects-invalid':
        return 'runners.err.allowedProjects';
      // #775: a hosted or GitHub Actions identity keeps the scope the console gave it.
      case 'runner-scope-fixed':
        return 'runners.err.scopeFixed';
      case 'runner-policy-invalid':
        return failure.field === 'runner' ? 'runners.err.policyRunner' : 'runners.err.policy';
      // #670: the dispatch switch's refusals.
      case 'access-source-hosted':
        return 'runners.err.accessSourceHosted';
      case 'dispatch-repository-unverified':
        return 'runners.err.repositoryUnverified';
      // #759: the screens that can name the items and link the setup page word it themselves.
      case ACTIONS_NOT_READY:
        return 'runners.err.actionsNotReadyBare';
      default:
        return 'runners.err.invalid';
    }
  }
  // #795: a subscription runner takes new projects from the owner who enrolled it only.
  if (failure.kind === 'forbidden' && failure.slug === 'runner-scope-enroller-only') {
    return 'runners.err.enrollerOnly';
  }
  if (failure.kind === 'forbidden' && failure.slug === 'runner-enroller-not-sole-owner') {
    return 'runners.err.enrollerNotSoleOwner';
  }
  if (failure.kind === 'forbidden' && failure.slug === 'account-suspended') {
    return 'runners.wizard.err.suspended';
  }
  if (failure.kind === 'conflict') {
    // Mismatch and changed read alike to the owner: the machine behind the request is not the one they saw.
    return failure.slug === 'enrolment-intent-limit' ? 'runners.wizard.err.limit' : 'runners.wizard.err.changed';
  }
  if (failure.kind === 'not-found' && failure.slug === 'enrolment-not-found') {
    return 'runners.err.enrolmentGone';
  }
  return FAILURE_KEYS[failure.kind];
}

const FAILURE_KEYS: Readonly<Record<Exclude<RunnerFailureKind, 'invalid' | 'conflict'>, string>> = {
  forbidden: 'runners.err.forbidden',
  'not-found': 'runners.err.notFound',
  revoked: 'runners.err.revoked',
  'not-suspect': 'runners.err.notSuspect',
  'enroller-set': 'runners.err.enrollerSet',
  'rate-limited': 'runners.err.rateLimited',
  offline: 'runners.err.offline',
  timeout: 'runners.err.timeout',
  'session-expired': 'runners.err.sessionExpired',
  error: 'runners.err.error',
};

/** Item ids are short kebab-case words; anything else in the problem body is left out. */
function itemIdsOf(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === 'string' && /^[a-z][a-z-]{0,39}$/.test(id))
    : [];
}
