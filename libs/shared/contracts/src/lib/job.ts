import { isUlid } from './account';
import { isNullable, isString, isTimestamp } from './guards';
import { InputError, checked, isRecord, oneOf, record, text, type InputCheck } from './tracker/inputs';

/**
 * Jobs, job tokens and placement (#467, ADR 0008 row 2-A; ADR 0006 "Runner and job queue", ADR 0008 decision 12).
 * A job names one project, one role and the items it holds; the opaque `tcj_` token the claim mints is accepted
 * only together with the identity of the runner that claimed it (R4).
 */

export const JOB_KINDS = [
  'slot-pm',
  'slot-dev',
  'slot-qa',
  'burn',
  'audit',
  'review',
  'chat',
  'kickoff',
  'import',
  'digest',
] as const;
export type JobKind = (typeof JOB_KINDS)[number];
export const isJobKind = (value: unknown): value is JobKind => (JOB_KINDS as readonly unknown[]).includes(value);

export const JOB_STATES = ['queued', 'claimed', 'running', 'finished', 'failed', 'lost', 'cancelled'] as const;
export type JobState = (typeof JOB_STATES)[number];
export const isJobState = (value: unknown): value is JobState => (JOB_STATES as readonly unknown[]).includes(value);

export const JOB_DISPATCHES = ['pull', 'actions', 'hosted'] as const;
export type JobDispatch = (typeof JOB_DISPATCHES)[number];

export const JOB_EVENT_KINDS = ['started', 'log', 'notice', 'acted', 'metric', 'paused', 'finished', 'failed'] as const;
export type JobEventKind = (typeof JOB_EVENT_KINDS)[number];
export const isJobEventKind = (value: unknown): value is JobEventKind =>
  (JOB_EVENT_KINDS as readonly unknown[]).includes(value);

export const JOB_EVENT_LEVELS = ['info', 'warn', 'error'] as const;
export type JobEventLevel = (typeof JOB_EVENT_LEVELS)[number];
export const isJobEventLevel = (value: unknown): value is JobEventLevel =>
  (JOB_EVENT_LEVELS as readonly unknown[]).includes(value);

/** The role a job kind runs as: a slot run is the orchestrator; a review names its role in the payload. */
export function roleOfJobKind(kind: JobKind, payloadRole: string | null): string {
  switch (kind) {
    case 'slot-pm':
    case 'slot-dev':
    case 'slot-qa':
    case 'burn':
    case 'kickoff':
      return 'orchestrator';
    case 'review':
      return payloadRole ?? 'reviewer';
    case 'chat':
    case 'digest':
    case 'import':
      return 'pm';
    case 'audit':
      return 'security';
  }
}

/** The lease a claim grants and a heartbeat extends (ADR 0006 "Run"). */
export const JOB_LEASE_SECONDS = 300;
/** A job lost (its lease lapsed) more than this often is failed, not requeued (ADR 0006: `attempt ≤ 2`). */
export const JOB_MAX_ATTEMPTS = 2;
/** The run log of one job is capped; past it the API writes one notice and drops the rest (threat model C2). */
export const JOB_EVENTS_MAX_PER_JOB = 5000;
export const JOB_EVENTS_MAX_PER_BATCH = 50;
export const JOB_EVENT_PAYLOAD_MAX_BYTES = 16384;
/** Three failures in a row pause the project (ADR 0006 `team_state`). */
export const TEAM_FAILURE_STREAK_PAUSE = 3;
export const JOB_MAX_MINUTES_DEFAULT = 90;
export const JOB_MAX_MINUTES_MAX = 720;
export const JOB_ITEMS_MAX = 100;
export const JOB_SUMMARY_MAX_LENGTH = 4096;

/** Placement (ADR 0008 decision 12), stored as this JSON in `projects.runner_policy` / `accounts.default_runner_policy`. */
export type RunnerPolicy =
  | { readonly mode: 'any' }
  | { readonly mode: 'pinned'; readonly runner: string }
  | {
      readonly mode: 'failover';
      readonly preferred: string;
      readonly fallback: readonly string[];
      readonly offline_after_seconds: number;
    };

export const RUNNER_POLICY_OFFLINE_DEFAULT_SECONDS = 300;
export const RUNNER_POLICY_OFFLINE_MIN_SECONDS = 30;
export const RUNNER_POLICY_OFFLINE_MAX_SECONDS = 86_400;
export const RUNNER_POLICY_FALLBACK_MAX = 20;

/** The runner ids a policy names, for the account check at write time. */
export function runnerIdsOfPolicy(policy: RunnerPolicy): readonly string[] {
  switch (policy.mode) {
    case 'any':
      return [];
    case 'pinned':
      return [policy.runner];
    case 'failover':
      return [policy.preferred, ...policy.fallback];
  }
}

export function checkRunnerPolicy(body: unknown): InputCheck<RunnerPolicy> {
  return checked(() => {
    if (!isRecord(body)) {
      throw new InputError('body', 'The policy must be a JSON object');
    }
    const mode = body['mode'];
    switch (mode) {
      case 'any':
        record(body, ['mode']);
        return { mode: 'any' };
      case 'pinned': {
        const fields = record(body, ['mode', 'runner']);
        if (!isUlid(fields['runner'])) {
          throw new InputError('runner', 'runner must be a runner id');
        }
        return { mode: 'pinned', runner: fields['runner'] };
      }
      case 'failover': {
        const fields = record(body, ['mode', 'preferred', 'fallback', 'offline_after_seconds']);
        const preferred = fields['preferred'];
        const fallback = fields['fallback'];
        const offline = fields['offline_after_seconds'] ?? RUNNER_POLICY_OFFLINE_DEFAULT_SECONDS;
        if (!isUlid(preferred)) {
          throw new InputError('preferred', 'preferred must be a runner id');
        }
        if (
          !Array.isArray(fallback) ||
          fallback.length === 0 ||
          fallback.length > RUNNER_POLICY_FALLBACK_MAX ||
          !fallback.every((id) => isUlid(id) && id !== preferred)
        ) {
          throw new InputError('fallback', 'fallback must be a list of runner ids other than preferred');
        }
        if (
          typeof offline !== 'number' ||
          !Number.isInteger(offline) ||
          offline < RUNNER_POLICY_OFFLINE_MIN_SECONDS ||
          offline > RUNNER_POLICY_OFFLINE_MAX_SECONDS
        ) {
          throw new InputError('offline_after_seconds', 'offline_after_seconds must be 30 to 86400');
        }
        return {
          mode: 'failover',
          preferred,
          fallback: [...new Set<string>(fallback as string[])],
          offline_after_seconds: offline,
        };
      }
      default:
        throw new InputError('mode', 'mode must be any, pinned or failover');
    }
  });
}

export interface RunnerPolicyDto {
  /** The project's own policy (`null` when it falls back to the account default). */
  readonly policy: RunnerPolicy | null;
  /** What the claim applies now: the project's, else the account's, else `any`. */
  readonly effective: RunnerPolicy;
}

/** A policy as the Worker answers it: exactly what `checkRunnerPolicy` would accept, with every member present. */
export function isRunnerPolicy(value: unknown): value is RunnerPolicy {
  const checkedPolicy = checkRunnerPolicy(value);
  return (
    checkedPolicy.ok &&
    (checkedPolicy.value.mode !== 'failover' || (isRecord(value) && 'offline_after_seconds' in value))
  );
}

export function isRunnerPolicyDto(value: unknown): value is RunnerPolicyDto {
  return (
    isRecord(value) &&
    (value['policy'] === null || isRunnerPolicy(value['policy'])) &&
    isRunnerPolicy(value['effective'])
  );
}

/** `POST /api/v1/projects/:slug/jobs` (Run now). */
export interface CreateJobInput {
  readonly kind: JobKind;
  readonly items: readonly number[];
  readonly needsLocal: boolean;
  readonly maxMinutes: number;
  /** A `review` job's role (`qa` | `reviewer` | `security`); ignored for other kinds. */
  readonly role: string | null;
}

function itemNumbers(value: unknown): number[] {
  if (value === undefined) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    value.length > JOB_ITEMS_MAX ||
    !value.every((n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 1)
  ) {
    throw new InputError('items', `items must be a list of at most ${String(JOB_ITEMS_MAX)} item numbers`);
  }
  return [...new Set<number>(value as number[])];
}

export function checkCreateJobInput(body: unknown): InputCheck<CreateJobInput> {
  return checked(() => {
    const fields = record(body, ['kind', 'items', 'needsLocal', 'maxMinutes', 'role']);
    const maxMinutes = fields['maxMinutes'] ?? JOB_MAX_MINUTES_DEFAULT;
    if (typeof maxMinutes !== 'number' || !Number.isInteger(maxMinutes) || maxMinutes < 1 || maxMinutes > JOB_MAX_MINUTES_MAX) {
      throw new InputError('maxMinutes', `maxMinutes must be 1 to ${String(JOB_MAX_MINUTES_MAX)}`);
    }
    const needsLocal = fields['needsLocal'] ?? false;
    if (typeof needsLocal !== 'boolean') {
      throw new InputError('needsLocal', 'needsLocal must be a boolean');
    }
    const role = fields['role'] ?? null;
    if (role !== null && (typeof role !== 'string' || !/^[a-z-]{2,32}$/.test(role))) {
      throw new InputError('role', 'role must be a role name');
    }
    return {
      kind: oneOf('kind', fields['kind'], isJobKind),
      items: itemNumbers(fields['items']),
      needsLocal,
      maxMinutes,
      role,
    };
  });
}

export interface JobDto {
  readonly id: string;
  readonly projectSlug: string;
  readonly kind: JobKind;
  readonly role: string;
  readonly state: JobState;
  readonly items: readonly number[];
  readonly priority: number;
  readonly requestedBy: string;
  readonly needsLocal: boolean;
  readonly dispatch: JobDispatch;
  readonly runnerId: string | null;
  readonly attempt: number;
  readonly maxMinutes: number;
  readonly createdAt: string;
  readonly claimedAt: string | null;
  readonly leaseUntil: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly result: Readonly<Record<string, unknown>> | null;
}

export interface JobListDto {
  readonly jobs: readonly JobDto[];
  readonly nextCursor: string | null;
}

export interface JobEventDto {
  readonly seq: number;
  readonly at: string;
  readonly level: JobEventLevel;
  readonly kind: JobEventKind;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface JobEventListDto {
  readonly events: readonly JobEventDto[];
  readonly nextCursor: number | null;
}

const isJobDispatch = (value: unknown): value is JobDispatch => (JOB_DISPATCHES as readonly unknown[]).includes(value);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Narrows a job as the Worker answers it (#464); the console renders none it did not check. */
export function isJobDto(value: unknown): value is JobDto {
  return (
    isRecord(value) &&
    isUlid(value['id']) &&
    isString(value['projectSlug']) &&
    isJobKind(value['kind']) &&
    isString(value['role']) &&
    isJobState(value['state']) &&
    Array.isArray(value['items']) &&
    value['items'].every(isCount) &&
    typeof value['priority'] === 'number' &&
    isString(value['requestedBy']) &&
    typeof value['needsLocal'] === 'boolean' &&
    isJobDispatch(value['dispatch']) &&
    isNullable(value['runnerId'], isUlid) &&
    isCount(value['attempt']) &&
    isCount(value['maxMinutes']) &&
    isTimestamp(value['createdAt']) &&
    isNullable(value['claimedAt'], isTimestamp) &&
    isNullable(value['leaseUntil'], isTimestamp) &&
    isNullable(value['startedAt'], isTimestamp) &&
    isNullable(value['finishedAt'], isTimestamp) &&
    isNullable(value['result'], isRecord)
  );
}

export function isJobListDto(value: unknown): value is JobListDto {
  return (
    isRecord(value) &&
    Array.isArray(value['jobs']) &&
    value['jobs'].every(isJobDto) &&
    isNullable(value['nextCursor'], isUlid)
  );
}

export function isJobEventDto(value: unknown): value is JobEventDto {
  return (
    isRecord(value) &&
    isCount(value['seq']) &&
    isTimestamp(value['at']) &&
    isJobEventLevel(value['level']) &&
    isJobEventKind(value['kind']) &&
    isRecord(value['payload'])
  );
}

export function isJobEventListDto(value: unknown): value is JobEventListDto {
  return (
    isRecord(value) &&
    Array.isArray(value['events']) &&
    value['events'].every(isJobEventDto) &&
    isNullable(value['nextCursor'], isCount)
  );
}

/** `POST /api/v1/runner/jobs/claim` → 200 with this, or 204 with `Retry-After`. */
export interface ClaimResponse {
  readonly job: JobDto;
  /** Shown once; the console keeps its hash. Presented as `Authorization: Bearer` with the runner JWT in `X-Runner-Jwt`. */
  readonly jobToken: string;
  readonly leaseSeconds: number;
}

export interface HeartbeatResponse {
  readonly leaseUntil: string;
}

export interface JobEventInput {
  readonly level: JobEventLevel;
  readonly kind: JobEventKind;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface JobEventsInput {
  readonly events: readonly JobEventInput[];
}

export interface JobEventsResponse {
  /** The `seq` of the last event written; events past the cap are dropped and `capped` says so. */
  readonly lastSeq: number;
  readonly capped: boolean;
}

export interface FinishJobInput {
  readonly result: 'finished' | 'failed';
  readonly summary: string;
  readonly metrics: Readonly<Record<string, unknown>>;
  readonly acted: boolean;
}

function jsonObject(field: string, value: unknown, maxBytes: number): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new InputError(field, `${field} must be a JSON object`);
  }
  if (new TextEncoder().encode(JSON.stringify(value)).length > maxBytes) {
    throw new InputError(field, `${field} must be at most ${String(maxBytes)} bytes`);
  }
  return value;
}

export function checkJobEventsInput(body: unknown): InputCheck<JobEventsInput> {
  return checked(() => {
    const fields = record(body, ['events']);
    const events = fields['events'];
    if (!Array.isArray(events) || events.length === 0 || events.length > JOB_EVENTS_MAX_PER_BATCH) {
      throw new InputError('events', `events must be 1 to ${String(JOB_EVENTS_MAX_PER_BATCH)} events`);
    }
    return {
      events: events.map((event: unknown, index) => {
        const item = record(event, ['level', 'kind', 'payload']);
        const field = `events[${String(index)}]`;
        return {
          level: oneOf(`${field}.level`, item['level'], isJobEventLevel),
          kind: oneOf(`${field}.kind`, item['kind'], isJobEventKind),
          payload: jsonObject(`${field}.payload`, item['payload'], JOB_EVENT_PAYLOAD_MAX_BYTES),
        };
      }),
    };
  });
}

export function checkFinishJobInput(body: unknown): InputCheck<FinishJobInput> {
  return checked(() => {
    const fields = record(body, ['result', 'summary', 'metrics', 'acted']);
    const result = fields['result'];
    if (result !== 'finished' && result !== 'failed') {
      throw new InputError('result', 'result must be finished or failed');
    }
    const acted = fields['acted'] ?? false;
    if (typeof acted !== 'boolean') {
      throw new InputError('acted', 'acted must be a boolean');
    }
    return {
      result,
      summary: text('summary', fields['summary'] ?? '', JOB_SUMMARY_MAX_LENGTH),
      metrics: jsonObject('metrics', fields['metrics'], JOB_EVENT_PAYLOAD_MAX_BYTES),
      acted,
    };
  });
}

export interface TeamStateDto {
  readonly paused: boolean;
  readonly pausedAt: string | null;
  readonly pausedBy: string | null;
  readonly failedStreak: number;
}
