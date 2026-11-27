import { isUlid } from './account';
import { isNullable, isTimestamp } from './guards';
import { isJobDto, type ClaimResponse } from './job';
import { isRunnerCheckKind, isRunnerScopeDto, type RunnerCheckKind } from './runner';
import { isResolvedTeamConfig } from './team-config';
import { InputError, checked, isRecord, oneOf, record, type InputCheck } from './tracker/inputs';

/**
 * Runner checks (#1059, migration 0049; architect note §1–§3, security note S1–S12). A check is a runner-addressed
 * probe, not a job: the owner starts one on a runner of the account, the runner's own claim poll picks it up (only a
 * poll that declares the kind), runs the fixed command its signed release holds for the kind, and reports a version
 * string or a reason code. Nothing in a check is a credential, a path or output of the command.
 */

export const RUNNER_CHECK_STATES = ['queued', 'running', 'passed', 'failed'] as const;
export type RunnerCheckState = (typeof RUNNER_CHECK_STATES)[number];
export const isRunnerCheckState = (value: unknown): value is RunnerCheckState =>
  (RUNNER_CHECK_STATES as readonly unknown[]).includes(value);

/**
 * What a runner may report on `finish` (S5): the credential's presence, Claude Code on the host, the time limit, the
 * host itself. Never the credential's kind or storage (C10): the three `credential-*` codes are the same for each.
 */
export const RUNNER_REPORTED_CHECK_REASONS = [
  'credential-missing',
  'credential-unreadable',
  'credential-not-allowed',
  'claude-not-configured',
  'claude-not-executable',
  'claude-failed',
  'claude-output-unrecognised',
  'timeout',
  'host-not-ready',
] as const;
export type RunnerReportedCheckReason = (typeof RUNNER_REPORTED_CHECK_REASONS)[number];
export const isRunnerReportedCheckReason = (value: unknown): value is RunnerReportedCheckReason =>
  (RUNNER_REPORTED_CHECK_REASONS as readonly unknown[]).includes(value);

/** What only the server sets on a stored check: never picked up, lost after the pick-up, the runner revoked. */
export const RUNNER_EXPIRED_CHECK_REASONS = ['not-picked-up', 'lost', 'runner-revoked'] as const;
export type RunnerExpiredCheckReason = (typeof RUNNER_EXPIRED_CHECK_REASONS)[number];

/** Why the console refuses to start a check (the problem `type` of the enqueue's 409/422/429). */
export const RUNNER_CHECK_REFUSALS = [
  'runner-revoked',
  'runner-check-unsupported',
  'runner-paused',
  'runner-offline',
  'runner-outdated',
  'rate-limited',
] as const;
export type RunnerCheckRefusal = (typeof RUNNER_CHECK_REFUSALS)[number];

type RunnerStoredCheckReasonOrRefusal = RunnerReportedCheckReason | RunnerExpiredCheckReason | RunnerCheckRefusal;

/**
 * Every machine-readable outcome of a check the console maps to copy (architect note §3): a stored reason, or an
 * enqueue refusal. The UX falls back to its generic state for anything else.
 */
export const RUNNER_CHECK_REASONS = [
  ...RUNNER_REPORTED_CHECK_REASONS,
  ...RUNNER_EXPIRED_CHECK_REASONS,
  'runner-check-unsupported',
  'runner-paused',
  'runner-offline',
  'runner-outdated',
  'rate-limited',
] as const satisfies readonly (RunnerStoredCheckReasonOrRefusal)[];
export type RunnerCheckReason = (typeof RUNNER_CHECK_REASONS)[number];
export const isRunnerCheckReason = (value: unknown): value is RunnerCheckReason =>
  (RUNNER_CHECK_REASONS as readonly unknown[]).includes(value);

/** What a stored check's `reason` can be (migration 0049's CHECK list). */
export const RUNNER_STORED_CHECK_REASONS = [
  ...RUNNER_REPORTED_CHECK_REASONS,
  ...RUNNER_EXPIRED_CHECK_REASONS,
] as const;
export type RunnerStoredCheckReason = RunnerReportedCheckReason | RunnerExpiredCheckReason;
export const isRunnerStoredCheckReason = (value: unknown): value is RunnerStoredCheckReason =>
  (RUNNER_STORED_CHECK_REASONS as readonly unknown[]).includes(value);

/**
 * The one version shape a check may carry (S5), shared by the runner's output parser and the console's `finish`: three
 * bounded numbers and an optional bounded suffix. Anchored and without nested quantifiers, so it cannot backtrack.
 */
export const RUNNER_CHECK_VERSION_PATTERN = /^\d{1,6}\.\d{1,6}\.\d{1,6}([-+][0-9A-Za-z.-]{1,32})?$/;
export const isClaudeVersion = (value: unknown): value is string =>
  typeof value === 'string' && RUNNER_CHECK_VERSION_PATTERN.test(value);

/** The runner's own time limit for a check (S2: the server's figure can only shorten it). */
export const RUNNER_CHECK_DEADLINE_SECONDS = 30;
/** A queued check nobody picked up within this is `not-picked-up`; the pick-up never takes an older one. */
export const RUNNER_CHECK_PICKUP_SECONDS = 150;
/** A running check without a finish this long after the pick-up is `lost`; `finish` refuses it from then on. */
export const RUNNER_CHECK_RUNNING_SECONDS = 90;
/** `finish`'s `durationMs` bound (S5); the column admits up to 120000 as a margin. */
export const RUNNER_CHECK_DURATION_MAX_MS = 60_000;
/** Created checks per runner, and per account, in any one hour (S12/T8). Replays and refusals never count. */
export const RUNNER_CHECKS_PER_RUNNER_PER_HOUR = 10;
export const RUNNER_CHECKS_PER_ACCOUNT_PER_HOUR = 30;
/** Finished checks older than this are pruned in the enqueue batch; their audit rows stay. */
export const RUNNER_CHECK_RETENTION_DAYS = 30;

/** `GET …/runners/:runner/checks/:check` and the enqueue's answer: this exact key set. */
export interface RunnerCheckDto {
  readonly id: string;
  readonly kind: RunnerCheckKind;
  readonly state: RunnerCheckState;
  readonly reason: RunnerCheckReason | null;
  /** A text node only (S5): matched by `RUNNER_CHECK_VERSION_PATTERN`, `null` unless `passed`. */
  readonly claudeVersion: string | null;
  readonly createdAt: string;
  readonly pickedAt: string | null;
  readonly finishedAt: string | null;
}

const RUNNER_CHECK_DTO_KEYS: readonly (keyof RunnerCheckDto)[] = [
  'id',
  'kind',
  'state',
  'reason',
  'claudeVersion',
  'createdAt',
  'pickedAt',
  'finishedAt',
];

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

export function isRunnerCheckDto(value: unknown): value is RunnerCheckDto {
  return (
    isRecord(value) &&
    hasExactKeys(value, RUNNER_CHECK_DTO_KEYS) &&
    isUlid(value['id']) &&
    isRunnerCheckKind(value['kind']) &&
    isRunnerCheckState(value['state']) &&
    isNullable(value['reason'], isRunnerCheckReason) &&
    (value['reason'] === null) === (value['state'] !== 'failed') &&
    isNullable(value['claudeVersion'], isClaudeVersion) &&
    (value['claudeVersion'] !== null) === (value['state'] === 'passed') &&
    isTimestamp(value['createdAt']) &&
    isNullable(value['pickedAt'], isTimestamp) &&
    isNullable(value['finishedAt'], isTimestamp)
  );
}

/** `POST …/accounts/:id/runners/:runner/checks`. */
export interface StartRunnerCheckInput {
  readonly kind: RunnerCheckKind;
}

export function checkStartRunnerCheckInput(body: unknown): InputCheck<StartRunnerCheckInput> {
  return checked(() => {
    const fields = record(body, ['kind']);
    return { kind: oneOf('kind', fields['kind'], isRunnerCheckKind) };
  });
}

/** `POST /api/v1/runner/checks/:id/finish` (S5): a pass with its version, or a failure with its reason. */
export type FinishRunnerCheckInput =
  | { readonly result: 'passed'; readonly claudeVersion: string; readonly durationMs: number }
  | { readonly result: 'failed'; readonly reason: RunnerReportedCheckReason; readonly durationMs: number };

/**
 * The finish body (S5). Exact keys; `passed` ⇔ a version, `failed` ⇔ a runner-reportable reason and no version. A
 * refusal names the field and never the submitted value, so nothing the runner sent is echoed into a log or a page.
 */
export function checkFinishRunnerCheckInput(body: unknown): InputCheck<FinishRunnerCheckInput> {
  return checked(() => {
    const fields = record(body, ['result', 'reason', 'claudeVersion', 'durationMs']);
    const durationMs = fields['durationMs'];
    if (
      typeof durationMs !== 'number' ||
      !Number.isInteger(durationMs) ||
      durationMs < 0 ||
      durationMs > RUNNER_CHECK_DURATION_MAX_MS
    ) {
      throw new InputError(
        'durationMs',
        `durationMs must be an integer from 0 to ${String(RUNNER_CHECK_DURATION_MAX_MS)}`,
      );
    }
    const result = fields['result'];
    if (result === 'passed') {
      if (fields['reason'] !== undefined) {
        throw new InputError('reason', 'reason is only sent with a failed result');
      }
      if (!isClaudeVersion(fields['claudeVersion'])) {
        throw new InputError('claudeVersion', 'claudeVersion must be a version like 2.1.3');
      }
      return { result, claudeVersion: fields['claudeVersion'], durationMs };
    }
    if (result === 'failed') {
      if (fields['claudeVersion'] !== undefined) {
        throw new InputError('claudeVersion', 'claudeVersion is only sent with a passed result');
      }
      if (!isRunnerReportedCheckReason(fields['reason'])) {
        throw new InputError('reason', 'reason is not one a runner may report');
      }
      return { result, reason: fields['reason'], durationMs };
    }
    throw new InputError('result', 'result must be passed or failed');
  });
}

/** The check half of the claim's answer (S2): what to run is the runner's own table; this names it only. */
export interface RunnerCheckClaimDto {
  readonly id: string;
  readonly kind: RunnerCheckKind;
  /** Display only: the runner's time limit is `min(local, deadlineSeconds)`. */
  readonly deadlineSeconds: number;
}

/** `POST /api/v1/runner/jobs/claim` → 200 with this when a check was picked up: no job, token, scope or config. */
export interface RunnerCheckClaimResponse {
  readonly check: RunnerCheckClaimDto;
}

export function isRunnerCheckClaimResponse(value: unknown): value is RunnerCheckClaimResponse {
  if (!isRecord(value) || !hasExactKeys(value, ['check'])) {
    return false;
  }
  const check = value['check'];
  return (
    isRecord(check) &&
    hasExactKeys(check, ['id', 'kind', 'deadlineSeconds']) &&
    isUlid(check['id']) &&
    isRunnerCheckKind(check['kind']) &&
    typeof check['deadlineSeconds'] === 'number' &&
    Number.isInteger(check['deadlineSeconds']) &&
    check['deadlineSeconds'] > 0 &&
    check['deadlineSeconds'] <= RUNNER_CHECK_DEADLINE_SECONDS
  );
}

const CLAIM_JOB_KEYS = ['job', 'jobToken', 'leaseSeconds', 'scope', 'teamConfig', 'teamConfigRevision'];

/**
 * The claim's 200 answer, one of two exact shapes: a job (`ClaimResponse`) or a check. A body that carries both, or
 * anything beside either, is neither.
 */
export type ClaimAnswer = ClaimResponse | RunnerCheckClaimResponse;

export function isClaimResponse(value: unknown): value is ClaimAnswer {
  if (isRunnerCheckClaimResponse(value)) {
    return true;
  }
  return (
    isRecord(value) &&
    hasExactKeys(value, CLAIM_JOB_KEYS) &&
    isJobDto(value['job']) &&
    typeof value['jobToken'] === 'string' &&
    value['jobToken'].length > 0 &&
    typeof value['leaseSeconds'] === 'number' &&
    Number.isInteger(value['leaseSeconds']) &&
    value['leaseSeconds'] > 0 &&
    isRunnerScopeDto(value['scope']) &&
    isResolvedTeamConfig(value['teamConfig']) &&
    (value['teamConfigRevision'] === null ||
      (typeof value['teamConfigRevision'] === 'number' && Number.isInteger(value['teamConfigRevision'])))
  );
}

