import { isUlid } from './account';
import { isNullable, isString, isStringList, isTimestamp } from './guards';
import { isValidSlug } from './project-slug';
import { InputError, checked, isRecord, oneOf, record, text, type InputCheck } from './tracker/inputs';

/**
 * Runners, their enrolment and the runner JWT (#467, ADR 0008 row 2-A; ADR 0006 "Runner and job queue" as ADR 0008
 * decisions 7, 8 and 12 amend it). The console stores a runner's public Ed25519 JWK and nothing secret; the enrolment
 * code is a 256-bit one-time value whose hash alone reaches D1.
 */

/** ADR 0008 decision 8: the four isolation backends. `none` is for fixture environments only. */
export const RUNNER_ISOLATIONS = ['container', 'user', 'actions-ephemeral', 'none'] as const;
export type RunnerIsolation = (typeof RUNNER_ISOLATIONS)[number];
export const isRunnerIsolation = (value: unknown): value is RunnerIsolation =>
  (RUNNER_ISOLATIONS as readonly unknown[]).includes(value);

export const RUNNER_SUSPECT_REASONS = ['new-country', 'two-pollers'] as const;
export type RunnerSuspectReason = (typeof RUNNER_SUSPECT_REASONS)[number];

export const RUNNER_NAME_MAX_LENGTH = 64;
export const RUNNER_HOST_FIELD_MAX_LENGTH = 128;
export const RUNNER_ALLOWED_PROJECTS_MAX = 100;
export const RUNNER_MAX_CONCURRENCY_MAX = 32;
/** A release label: `1.2.3`, `1.2.3-rc.1`, `0.0.0-dev+abc`. */
const RUNNER_VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;
export const isRunnerVersion = (value: unknown): value is string =>
  typeof value === 'string' && RUNNER_VERSION.test(value);

/** The runner JWT (ADR 0008 "Customer runner authentication without Access"): `exp` at most this far after `iat`. */
export const RUNNER_JWT_MAX_AGE_SECONDS = 300;
/** An enrolment code lives ten minutes (ADR 0006 "Enrolment"). */
export const ENROLMENT_CODE_TTL_SECONDS = 600;
/** A runner with no call for this long is offline on Settings › Runners (ADR 0006 "Report"). */
export const RUNNER_ONLINE_WINDOW_SECONDS = 300;
/** How often a runner polls `claim` when nothing is queued (ADR 0006 "Claim": the idle interval). */
export const RUNNER_POLL_SECONDS = 60;

/** The `aud` of a runner JWT: the environment, so a token signed for dev never verifies on production. */
export function runnerAudienceOf(environment: string): string {
  return `team-console:${environment}`;
}

/** An Ed25519 public key as the runner posts it at enrolment: these members and no `d`. */
export interface Ed25519PublicJwk {
  readonly kty: 'OKP';
  readonly crv: 'Ed25519';
  readonly x: string;
}

const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/;

export function isEd25519PublicJwk(value: unknown): value is Ed25519PublicJwk {
  return (
    isRecord(value) &&
    value['kty'] === 'OKP' &&
    value['crv'] === 'Ed25519' &&
    typeof value['x'] === 'string' &&
    BASE64URL_32_BYTES.test(value['x']) &&
    !('d' in value) &&
    Object.keys(value).every((key) => ['kty', 'crv', 'x', 'alg', 'use', 'kid'].includes(key))
  );
}

export interface RunnerHostDto {
  readonly os: string;
  readonly arch: string;
  readonly hostname: string;
}

export interface RunnerCapabilitiesDto {
  /** Whether a `needs:local` job may reach this runner (ADR 0006 "Host-agnostic"). */
  readonly local: boolean;
  readonly maxConcurrency: number;
}

/** `POST /api/v1/runner/enrol`: the runner's half of the enrolment; name and projects were the owner's at code time. */
export interface EnrolRunnerInput {
  readonly code: string;
  readonly publicKey: Ed25519PublicJwk;
  readonly host: RunnerHostDto;
  readonly capabilities: RunnerCapabilitiesDto;
  readonly isolation: RunnerIsolation;
  readonly version: string;
}

export interface EnrolRunnerResponse {
  readonly runnerId: string;
  readonly accountId: string;
  readonly name: string;
  /** The `aud` every runner JWT of this environment must carry. */
  readonly audience: string;
  readonly allowedProjects: readonly string[];
  readonly pollSeconds: number;
}

/** `POST /api/v1/accounts/:id/runners/enrolment-code`. */
export interface CreateEnrolmentCodeInput {
  readonly name: string;
  readonly allowedProjects: readonly string[];
}

export interface EnrolmentCodeDto {
  /** Shown once; the console keeps its hash only. */
  readonly code: string;
  readonly expiresAt: string;
  readonly apiUrl: string;
  readonly audience: string;
  readonly name: string;
  readonly allowedProjects: readonly string[];
}

/** `PATCH /api/v1/accounts/:id/runners/:runnerId`. */
export interface UpdateRunnerInput {
  readonly allowedProjects: readonly string[];
}

export interface RunnerSuspectDto {
  readonly at: string;
  readonly reason: RunnerSuspectReason;
}

export interface RunnerDto {
  readonly id: string;
  readonly name: string;
  readonly isolation: RunnerIsolation;
  readonly hosted: boolean;
  readonly version: string;
  readonly pinnedVersion: string | null;
  readonly host: RunnerHostDto;
  readonly capabilities: RunnerCapabilitiesDto;
  readonly allowedProjects: readonly string[];
  readonly enrolledAt: string;
  readonly lastSeenAt: string | null;
  readonly lastSeenCountry: string | null;
  readonly online: boolean;
  readonly suspect: RunnerSuspectDto | null;
  readonly revokedAt: string | null;
  /**
   * Below `RUNNER_MINIMUM_VERSION` (#464, ADR 0008 row 2-E): the owner should update it. Judged by the Worker with
   * `isRunnerVersionBelow`, so the console never needs the runner door's `GET /runner/release`.
   */
  readonly belowMinimum: boolean;
}

/**
 * An enrolment code that can still enrol a runner (#492): unused and not expired. Never the code. `id` is the
 * code's SHA-256, the key D1 already holds, and is what `POST …/enrolment-codes/:id/withdraw` names.
 * Because `id` is also the DB lookup key (`runner_enrolments.code_hash`, the primary key), it must stay unique per
 * code: never shorten it, re-encode it or replace it with a display id (#522).
 */
export interface PendingEnrolmentDto {
  readonly id: string;
  readonly name: string;
  readonly allowedProjects: readonly string[];
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface RunnerListDto {
  readonly runners: readonly RunnerDto[];
  /** The account's pending enrolment codes, oldest first, so the owner can withdraw one before it expires. */
  readonly pendingEnrolments: readonly PendingEnrolmentDto[];
  /** The release the environment names (`GET /runner/release`'s answer), for Settings › Runners. */
  readonly release: RunnerReleaseDto;
}

/** `GET /api/v1/runner/release`: the release the console names; the runner verifies it against its own trust root. */
export interface RunnerReleaseDto {
  readonly version: string | null;
  readonly minimumVersion: string | null;
}

function slugList(field: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.length > RUNNER_ALLOWED_PROJECTS_MAX) {
    throw new InputError(
      field,
      `${field} must be a list of at most ${String(RUNNER_ALLOWED_PROJECTS_MAX)} project slugs`,
    );
  }
  if (!value.every((slug) => typeof slug === 'string' && isValidSlug(slug))) {
    throw new InputError(field, `${field} holds something that is not a project slug`);
  }
  return [...new Set<string>(value as string[])];
}

function runnerName(value: unknown): string {
  const cleaned = text('name', value, RUNNER_NAME_MAX_LENGTH, 1).trim();
  if (cleaned.length === 0 || cleaned.length > RUNNER_NAME_MAX_LENGTH) {
    throw new InputError('name', `name must be 1 to ${String(RUNNER_NAME_MAX_LENGTH)} characters`);
  }
  return cleaned;
}

function host(value: unknown): RunnerHostDto {
  const fields = record(value, ['os', 'arch', 'hostname']);
  return {
    os: text('host.os', fields['os'], RUNNER_HOST_FIELD_MAX_LENGTH, 1),
    arch: text('host.arch', fields['arch'], RUNNER_HOST_FIELD_MAX_LENGTH, 1),
    hostname: text('host.hostname', fields['hostname'], RUNNER_HOST_FIELD_MAX_LENGTH, 1),
  };
}

function capabilities(value: unknown): RunnerCapabilitiesDto {
  const fields = record(value, ['local', 'maxConcurrency']);
  if (typeof fields['local'] !== 'boolean') {
    throw new InputError('capabilities.local', 'capabilities.local must be a boolean');
  }
  const concurrency = fields['maxConcurrency'];
  if (
    typeof concurrency !== 'number' ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > RUNNER_MAX_CONCURRENCY_MAX
  ) {
    throw new InputError(
      'capabilities.maxConcurrency',
      `capabilities.maxConcurrency must be an integer from 1 to ${String(RUNNER_MAX_CONCURRENCY_MAX)}`,
    );
  }
  return { local: fields['local'], maxConcurrency: concurrency };
}

export function checkCreateEnrolmentCodeInput(body: unknown): InputCheck<CreateEnrolmentCodeInput> {
  return checked(() => {
    const fields = record(body, ['name', 'allowedProjects']);
    return { name: runnerName(fields['name']), allowedProjects: slugList('allowedProjects', fields['allowedProjects']) };
  });
}

export function checkUpdateRunnerInput(body: unknown): InputCheck<UpdateRunnerInput> {
  return checked(() => {
    const fields = record(body, ['allowedProjects']);
    return { allowedProjects: slugList('allowedProjects', fields['allowedProjects']) };
  });
}

/**
 * The enrol body. The code's shape is checked here only loosely (a string of the right length): whether it is a
 * live code is the route's answer, one 401 for every wrong code, so nothing about codes is enumerable.
 */
export function checkEnrolRunnerInput(body: unknown): InputCheck<EnrolRunnerInput> {
  return checked(() => {
    const fields = record(body, ['code', 'publicKey', 'host', 'capabilities', 'isolation', 'version']);
    const publicKey = fields['publicKey'];
    if (!isEd25519PublicJwk(publicKey)) {
      throw new InputError('publicKey', 'publicKey must be an Ed25519 public JWK (kty OKP, crv Ed25519, x)');
    }
    return {
      code: text('code', fields['code'], 128, 1),
      publicKey: { kty: 'OKP', crv: 'Ed25519', x: publicKey.x },
      host: host(fields['host']),
      capabilities: capabilities(fields['capabilities']),
      isolation: oneOf('isolation', fields['isolation'], isRunnerIsolation),
      version: oneOf('version', fields['version'], isRunnerVersion),
    };
  });
}

export function isRunnerId(value: unknown): value is string {
  return isUlid(value);
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** A pending enrolment's id: the lowercase hex SHA-256 of its code, the shape `runner_enrolments.code_hash` CHECKs. */
export function isEnrolmentId(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value);
}

const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const NUMERIC_IDENTIFIER = /^[0-9]+$/;

function comparePrerelease(a: string | undefined, b: string | undefined): number {
  if (a === undefined || b === undefined) {
    // A release outranks any of its pre-releases (SemVer 2.0.0 §11.3).
    return a === b ? 0 : a === undefined ? 1 : -1;
  }
  const left = a.split('.');
  const right = b.split('.');
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const x = left[index] ?? '';
    const y = right[index] ?? '';
    if (x === y) {
      continue;
    }
    const xNumeric = NUMERIC_IDENTIFIER.test(x);
    const yNumeric = NUMERIC_IDENTIFIER.test(y);
    if (xNumeric && yNumeric) {
      return Number(x) < Number(y) ? -1 : 1;
    }
    if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1;
    }
    return x < y ? -1 : 1;
  }
  return Math.sign(left.length - right.length);
}

/**
 * SemVer 2.0.0 precedence of two runner release labels: negative, zero or positive; `null` when either is not
 * `MAJOR.MINOR.PATCH[-pre][+build]` (build metadata is ignored, as the spec says).
 */
export function compareRunnerVersions(a: string, b: string): number | null {
  const left = SEMVER.exec(a);
  const right = SEMVER.exec(b);
  if (left === null || right === null) {
    return null;
  }
  for (const index of [1, 2, 3]) {
    const difference = Number(left[index]) - Number(right[index]);
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }
  return comparePrerelease(left[4], right[4]);
}

/**
 * Whether a runner's version is below the environment's minimum. With no minimum nothing is below it; a label that
 * cannot be compared with one (not SemVer) counts as below — it cannot be shown to meet it.
 */
export function isRunnerVersionBelow(version: string, minimum: string | null): boolean {
  if (minimum === null) {
    return false;
  }
  const order = compareRunnerVersions(version, minimum);
  return order === null || order < 0;
}

/** The runner binary's name on the customer's host (ADR 0008 "Runner, installer and hosted dispatch"). */
export const RUNNER_BINARY = 'team-console-runner';

const ENROLMENT_API_URL = /^https?:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/;
const ENROLMENT_CODE_SHAPE = /^[a-z]{2,8}_[A-Za-z0-9_-]{16,128}$/;

/**
 * The one command Settings › Runners shows beside a fresh code (#464): `enrol --url <origin> --code <code>`; the
 * runner's `enrol` (2-B) takes the same two flags. `null` when either part could carry a shell metacharacter, so a
 * surprising answer is never offered for pasting into a terminal.
 */
export function enrolCommandOf(enrolment: Pick<EnrolmentCodeDto, 'apiUrl' | 'code'>): string | null {
  if (!ENROLMENT_API_URL.test(enrolment.apiUrl) || !ENROLMENT_CODE_SHAPE.test(enrolment.code)) {
    return null;
  }
  return `${RUNNER_BINARY} enrol --url ${enrolment.apiUrl} --code ${enrolment.code}`;
}

export function isRunnerReleaseDto(value: unknown): value is RunnerReleaseDto {
  return (
    isRecord(value) &&
    isNullable(value['version'], isRunnerVersion) &&
    isNullable(value['minimumVersion'], isRunnerVersion)
  );
}

function isRunnerHostDto(value: unknown): value is RunnerHostDto {
  return isRecord(value) && isString(value['os']) && isString(value['arch']) && isString(value['hostname']);
}

function isRunnerCapabilitiesDto(value: unknown): value is RunnerCapabilitiesDto {
  return (
    isRecord(value) &&
    typeof value['local'] === 'boolean' &&
    typeof value['maxConcurrency'] === 'number' &&
    Number.isInteger(value['maxConcurrency'])
  );
}

function isRunnerSuspectDto(value: unknown): value is RunnerSuspectDto {
  return (
    isRecord(value) &&
    isTimestamp(value['at']) &&
    (RUNNER_SUSPECT_REASONS as readonly unknown[]).includes(value['reason'])
  );
}

/** Narrows a runner as the Worker answers it; the console renders none it did not check. */
export function isRunnerDto(value: unknown): value is RunnerDto {
  return (
    isRecord(value) &&
    isRunnerId(value['id']) &&
    isString(value['name']) &&
    isRunnerIsolation(value['isolation']) &&
    typeof value['hosted'] === 'boolean' &&
    isString(value['version']) &&
    isNullable(value['pinnedVersion'], isString) &&
    isRunnerHostDto(value['host']) &&
    isRunnerCapabilitiesDto(value['capabilities']) &&
    isStringList(value['allowedProjects']) &&
    isTimestamp(value['enrolledAt']) &&
    isNullable(value['lastSeenAt'], isTimestamp) &&
    isNullable(value['lastSeenCountry'], isString) &&
    typeof value['online'] === 'boolean' &&
    isNullable(value['suspect'], isRunnerSuspectDto) &&
    isNullable(value['revokedAt'], isTimestamp) &&
    typeof value['belowMinimum'] === 'boolean'
  );
}

export function isPendingEnrolmentDto(value: unknown): value is PendingEnrolmentDto {
  return (
    isRecord(value) &&
    isEnrolmentId(value['id']) &&
    isString(value['name']) &&
    isStringList(value['allowedProjects']) &&
    isTimestamp(value['createdAt']) &&
    isTimestamp(value['expiresAt'])
  );
}

export function isRunnerListDto(value: unknown): value is RunnerListDto {
  return (
    isRecord(value) &&
    Array.isArray(value['runners']) &&
    value['runners'].every(isRunnerDto) &&
    Array.isArray(value['pendingEnrolments']) &&
    value['pendingEnrolments'].every(isPendingEnrolmentDto) &&
    isRunnerReleaseDto(value['release'])
  );
}

export function isEnrolmentCodeDto(value: unknown): value is EnrolmentCodeDto {
  return (
    isRecord(value) &&
    isString(value['code']) &&
    isTimestamp(value['expiresAt']) &&
    isString(value['apiUrl']) &&
    isString(value['audience']) &&
    isString(value['name']) &&
    isStringList(value['allowedProjects'])
  );
}
