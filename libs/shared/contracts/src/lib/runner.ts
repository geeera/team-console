import { isUlid } from './account';
import { isDisplayName, isNullable, isString, isStringList, isTimestamp } from './guards';
import { isValidSlug } from './project-slug';
import { ACCESS_SOURCES, isAccessSource, type AccessSource } from './team-config';
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
/**
 * What an enrolment code can grant (#668): every backend but `actions-ephemeral`, which only a verified GitHub OIDC
 * exchange creates, for one job on a VM GitHub discards (threat model C11).
 */
export const ENROLMENT_ISOLATIONS = ['container', 'user', 'none'] as const satisfies readonly RunnerIsolation[];
export type EnrolmentIsolation = (typeof ENROLMENT_ISOLATIONS)[number];
export const isEnrolmentIsolation = (value: unknown): value is EnrolmentIsolation =>
  (ENROLMENT_ISOLATIONS as readonly unknown[]).includes(value);

/**
 * Which projects a runner may claim (#775, migration 0036): every active project of its account, present and future
 * (`all`), or the list in `allowedProjects` (`selected`). The claim and every job-token write judge it inside their
 * own statement (`runnerServesSql`), always together with the account match; a job keeps its project-only scope.
 */
export const RUNNER_PROJECT_SCOPES = ['all', 'selected'] as const;
export type RunnerProjectScope = (typeof RUNNER_PROJECT_SCOPES)[number];
export const isRunnerProjectScope = (value: unknown): value is RunnerProjectScope =>
  (RUNNER_PROJECT_SCOPES as readonly unknown[]).includes(value);
/** What a new runner gets when the owner does not choose (owner, 2026-11-17; SECURITY question 6). */
export const DEFAULT_RUNNER_PROJECT_SCOPE: RunnerProjectScope = 'all';

/** The scope as the owner set it: under `all` the list is always empty (the 0036 CHECK). */
export interface RunnerProjectScopeDto {
  readonly projectScope: RunnerProjectScope;
  readonly allowedProjects: readonly string[];
}

/**
 * Whether a runner with this scope may serve `slug` of its own account, as the console shows it. The claim's own term
 * also applies owner decision D3 (a subscription runner under `all` in a multi-owner account), which needs D1; this
 * is the display-side approximation and never an authorisation.
 */
export function runnerScopeCovers(scope: RunnerProjectScopeDto, slug: string): boolean {
  return scope.projectScope === 'all' || scope.allowedProjects.includes(slug);
}

export const RUNNER_SUSPECT_REASONS = ['new-country', 'two-pollers'] as const;
export type RunnerSuspectReason = (typeof RUNNER_SUSPECT_REASONS)[number];

/**
 * Why a runner stopped claiming (#571, ADR 0008 decision 9; migration 0028): the CLI's usage or rate limit, which the
 * runner detects and enforces, or a pause by hand. The console records it and claims nothing for the runner meanwhile.
 */
export const RUNNER_PAUSE_REASONS = ['usage-limit', 'rate-limit', 'manual'] as const;
export type RunnerPauseReason = (typeof RUNNER_PAUSE_REASONS)[number];
export const isRunnerPauseReason = (value: unknown): value is RunnerPauseReason =>
  (RUNNER_PAUSE_REASONS as readonly unknown[]).includes(value);

/** A job that failed on one of these hit a quota, not a fault: it never counts toward the failure streak. */
export const RUNNER_LIMIT_REASONS = ['usage-limit', 'rate-limit'] as const;
export type RunnerLimitReason = (typeof RUNNER_LIMIT_REASONS)[number];
export const isRunnerLimitReason = (value: unknown): value is RunnerLimitReason =>
  (RUNNER_LIMIT_REASONS as readonly unknown[]).includes(value);

/** `POST /runner/pause` takes an `until` at most this far ahead: a pause always lapses on its own within a day. */
export const RUNNER_PAUSE_MAX_SECONDS = 24 * 60 * 60;

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
  /**
   * The access sources the runner's credential can serve (#775, SECURITY question 7): `['api_key']` for an API key,
   * `['subscription']` for a Claude login or the host's own sign-in. A derived enum, never the credential's kind or
   * value. It only ever narrows the claim (an `AND` term); hosted and `actions-ephemeral` identities get it from the
   * server. Absent on runners enrolled before it existed, which the claim then does not narrow.
   */
  readonly accessSources?: readonly AccessSource[];
}

/** The runner's declaration, as the claim body carries it: a subset of `ACCESS_SOURCES`, never empty. */
export function accessSourcesOf(field: string, value: unknown): readonly AccessSource[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > ACCESS_SOURCES.length || !value.every(isAccessSource)) {
    throw new InputError(field, `${field} must name one or more of ${ACCESS_SOURCES.join(', ')}`);
  }
  return [...new Set<AccessSource>(value as AccessSource[])];
}

/** `POST /api/v1/runner/enrol`: the runner's half of the enrolment; name and projects were the owner's at code time. */
export interface EnrolRunnerInput {
  readonly code: string;
  readonly publicKey: Ed25519PublicJwk;
  readonly host: RunnerHostDto;
  readonly capabilities: RunnerCapabilitiesDto;
  readonly isolation: EnrolmentIsolation;
  readonly version: string;
}

export interface EnrolRunnerResponse extends RunnerProjectScopeDto {
  readonly runnerId: string;
  readonly accountId: string;
  readonly name: string;
  /** The `aud` every runner JWT of this environment must carry. */
  readonly audience: string;
  readonly pollSeconds: number;
}

/**
 * `POST /api/v1/accounts/:id/runners/enrolment-code`. `projectScope` defaults to `all` and `allowedProjects` to `[]`;
 * a list under `all` is refused, so the pair is never ambiguous.
 */
export interface CreateEnrolmentCodeInput extends RunnerProjectScopeDto {
  readonly name: string;
}

export interface EnrolmentCodeDto extends RunnerProjectScopeDto {
  /** Shown once; the console keeps its hash only. */
  readonly code: string;
  readonly expiresAt: string;
  readonly apiUrl: string;
  readonly audience: string;
  readonly name: string;
}

/** `PATCH /api/v1/accounts/:id/runners/:runnerId`: both keys, exactly (`allowedProjects` is `[]` under `all`). */
export type UpdateRunnerInput = RunnerProjectScopeDto;

/** `POST /api/v1/runner/jobs/claim`: the runner's declaration of what its credential serves; `{}` declares nothing. */
export interface ClaimRunnerInput {
  readonly accessSources?: readonly AccessSource[];
}

/** A project a runner serves now, with whether its declared `accessSources` fit the project's access source. */
export interface RunnerServedProjectDto {
  readonly slug: string;
  readonly accessSource: AccessSource;
  /** `true` while the runner declares nothing (nothing to compare), or declares the project's source. */
  readonly fit: boolean;
}

/**
 * `GET /api/v1/runner/self` (R-SELF): what the runner needs to hold itself to its scope and to check its credential
 * fit — this exact key set and nothing else (no suspect mark, no country, no other runner, no policy).
 */
export interface RunnerSelfDto {
  readonly runner: RunnerProjectScopeDto & {
    readonly id: string;
    readonly name: string;
    readonly accountId: string;
    readonly isolation: RunnerIsolation;
    readonly version: string;
    readonly belowMinimum: boolean;
    readonly pausedUntil: string | null;
    readonly lastSeenAt: string | null;
  };
  /** The active projects the runner may claim now, in slug order; the scope's effective answer, D3 applied. */
  readonly projects: readonly { readonly slug: string; readonly accessSource: AccessSource }[];
}

/**
 * The scope the console hands a runner with every claim (#775): the runner judges a job against the console's answer
 * of the moment, never against the copy `enrol` wrote. `projects` is the effective list, the same the claim applied.
 */
export interface RunnerScopeDto extends RunnerProjectScopeDto {
  readonly projects: readonly string[];
}

export interface RunnerSuspectDto {
  readonly at: string;
  readonly reason: RunnerSuspectReason;
}

export interface RunnerPauseDto {
  readonly reason: RunnerPauseReason;
  /** When the runner claims again (UTC); the pause lapses on its own then. */
  readonly until: string;
}

/** `POST /api/v1/runner/pause`. */
export interface PauseRunnerInput {
  readonly reason: RunnerPauseReason;
  readonly until: string;
}

export interface RunnerDto extends RunnerProjectScopeDto {
  readonly id: string;
  readonly name: string;
  readonly isolation: RunnerIsolation;
  readonly hosted: boolean;
  readonly version: string;
  readonly pinnedVersion: string | null;
  readonly host: RunnerHostDto;
  readonly capabilities: RunnerCapabilitiesDto;
  /** The active projects the runner serves now under its scope (D3 applied), with the credential fit of each. */
  readonly servedProjects: readonly RunnerServedProjectDto[];
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
  /** The pause in force now (#571): `null` once `until` has passed, whatever the row still says. */
  readonly pause: RunnerPauseDto | null;
  /**
   * Whether the caller enrolled this runner (#775, D3): judged for the reader, never who did, so the owner's client can
   * word the D3 state without any person's id, login or e-mail in the DTO.
   */
  readonly enrolledByYou: boolean;
  /**
   * The display name of the owner who enrolled it (#775, migration 0038), for the owner's D3 copy; `null` when that
   * owner has none or is not an owner of the account any more. Never a login, e-mail or user id.
   */
  readonly enrolledByName: string | null;
}

/**
 * An enrolment code that can still enrol a runner (#492): unused and not expired. Never the code. `id` is the
 * code's SHA-256, the key D1 already holds, and is what `POST …/enrolment-codes/:id/withdraw` names.
 * Because `id` is also the DB lookup key (`runner_enrolments.code_hash`, the primary key), it must stay unique per
 * code: never shorten it, re-encode it or replace it with a display id (#522).
 */
export interface PendingEnrolmentDto extends RunnerProjectScopeDto {
  readonly id: string;
  readonly name: string;
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

/** A runner's name as the owner typed it, trimmed; module-internal to the contracts lib. */
export function runnerName(value: unknown): string {
  const cleaned = text('name', value, RUNNER_NAME_MAX_LENGTH, 1).trim();
  if (cleaned.length === 0 || cleaned.length > RUNNER_NAME_MAX_LENGTH) {
    throw new InputError('name', `name must be 1 to ${String(RUNNER_NAME_MAX_LENGTH)} characters`);
  }
  return cleaned;
}

/** The `host` member of a runner's enrol or exchange body; module-internal to the contracts lib. */
export function runnerHostOf(value: unknown): RunnerHostDto {
  const fields = record(value, ['os', 'arch', 'hostname']);
  return {
    os: text('host.os', fields['os'], RUNNER_HOST_FIELD_MAX_LENGTH, 1),
    arch: text('host.arch', fields['arch'], RUNNER_HOST_FIELD_MAX_LENGTH, 1),
    hostname: text('host.hostname', fields['hostname'], RUNNER_HOST_FIELD_MAX_LENGTH, 1),
  };
}

/**
 * The scope pair of a code or a PATCH. `projectScope` defaults to `all` and `allowedProjects` to `[]` when `optional`;
 * a PATCH names both. Under `all` a non-empty list is refused: the scope is the one truth (migration 0036's CHECK).
 * Module-internal to the contracts lib.
 */
export function projectScopeOf(fields: Record<string, unknown>, optional: boolean): RunnerProjectScopeDto {
  const scope = fields['projectScope'];
  const list = fields['allowedProjects'];
  const projectScope =
    optional && scope === undefined ? DEFAULT_RUNNER_PROJECT_SCOPE : oneOf('projectScope', scope, isRunnerProjectScope);
  const allowedProjects = optional && list === undefined ? [] : slugList('allowedProjects', list);
  if (projectScope === 'all' && allowedProjects.length > 0) {
    throw new InputError('allowedProjects', 'allowedProjects must be empty when projectScope is all');
  }
  return { projectScope, allowedProjects };
}

/** The `capabilities` member of an enrol or bind body; module-internal to the contracts lib. */
export function capabilities(value: unknown): RunnerCapabilitiesDto {
  const fields = record(value, ['local', 'maxConcurrency', 'accessSources']);
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
  const declared = fields['accessSources'];
  return {
    local: fields['local'],
    maxConcurrency: concurrency,
    ...(declared === undefined ? {} : { accessSources: accessSourcesOf('capabilities.accessSources', declared) }),
  };
}

export function checkCreateEnrolmentCodeInput(body: unknown): InputCheck<CreateEnrolmentCodeInput> {
  return checked(() => {
    const fields = record(body, ['name', 'projectScope', 'allowedProjects']);
    return { name: runnerName(fields['name']), ...projectScopeOf(fields, true) };
  });
}

export function checkUpdateRunnerInput(body: unknown): InputCheck<UpdateRunnerInput> {
  return checked(() => projectScopeOf(record(body, ['projectScope', 'allowedProjects']), false));
}

/** The claim body: `{}` or the runner's `accessSources` declaration, nothing else. */
export function checkClaimRunnerInput(body: unknown): InputCheck<ClaimRunnerInput> {
  return checked(() => {
    // The runner sent `{}` since before the declaration existed; `null` is an empty body on the same door.
    const fields = record(body ?? {}, ['accessSources']);
    const declared = fields['accessSources'];
    return declared === undefined ? {} : { accessSources: accessSourcesOf('accessSources', declared) };
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
      host: runnerHostOf(fields['host']),
      capabilities: capabilities(fields['capabilities']),
      isolation: oneOf('isolation', fields['isolation'], isEnrolmentIsolation),
      version: oneOf('version', fields['version'], isRunnerVersion),
    };
  });
}

const UTC_TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,3})?Z$/;

/**
 * The pause body: a known reason and an `until` in UTC, later than `now` and at most `RUNNER_PAUSE_MAX_SECONDS`
 * ahead of it. `until` comes back normalised to `toISOString()`, the shape the column is compared in.
 */
export function checkPauseRunnerInput(body: unknown, now: Date): InputCheck<PauseRunnerInput> {
  return checked(() => {
    const fields = record(body, ['reason', 'until']);
    const reason = oneOf('reason', fields['reason'], isRunnerPauseReason);
    const until = fields['until'];
    const at = typeof until === 'string' && UTC_TIMESTAMP.test(until) ? Date.parse(until) : Number.NaN;
    // `Date.parse` rolls 31 February over into March; the date part must survive the round trip.
    if (typeof until !== 'string' || !Number.isFinite(at) || new Date(at).toISOString().slice(0, 19) !== until.slice(0, 19)) {
      throw new InputError('until', 'until must be a UTC timestamp like 2026-11-13T15:00:00.000Z');
    }
    if (at <= now.getTime()) {
      throw new InputError('until', 'until must be in the future');
    }
    if (at > now.getTime() + RUNNER_PAUSE_MAX_SECONDS * 1000) {
      throw new InputError('until', 'until must be at most 24 hours ahead');
    }
    return { reason, until: new Date(at).toISOString() };
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

/** A runner release's channel: `prerelease` for `MAJOR.MINOR.PATCH-pre`, `stable` for one without; `null` when not SemVer. */
export type RunnerReleaseChannel = 'stable' | 'prerelease';

export function runnerReleaseChannelOf(version: string): RunnerReleaseChannel | null {
  const match = SEMVER.exec(version);
  if (match === null) {
    return null;
  }
  return match[4] === undefined ? 'stable' : 'prerelease';
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

/** The variable the runner's `enrol` reads the one-time code from (#582). */
export const ENROL_CODE_ENV = 'TC_ENROL_CODE';

/**
 * The one command Settings › Runners shows beside a fresh code (#464): `TC_ENROL_CODE=<code> enrol --url <origin>`.
 * The code goes in the command's environment, not its argv, where any local user reads it with `ps` while enrol
 * runs (#582). `null` when either part could carry a shell metacharacter, so a surprising answer is never offered
 * for pasting into a terminal.
 */
export function enrolCommandOf(enrolment: Pick<EnrolmentCodeDto, 'apiUrl' | 'code'>): string | null {
  if (!ENROLMENT_API_URL.test(enrolment.apiUrl) || !ENROLMENT_CODE_SHAPE.test(enrolment.code)) {
    return null;
  }
  return `${ENROL_CODE_ENV}=${enrolment.code} ${RUNNER_BINARY} enrol --url ${enrolment.apiUrl}`;
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

function isAccessSourceList(value: unknown): value is readonly AccessSource[] {
  return Array.isArray(value) && value.every(isAccessSource);
}

function isRunnerCapabilitiesDto(value: unknown): value is RunnerCapabilitiesDto {
  return (
    isRecord(value) &&
    typeof value['local'] === 'boolean' &&
    typeof value['maxConcurrency'] === 'number' &&
    Number.isInteger(value['maxConcurrency']) &&
    (value['accessSources'] === undefined || isAccessSourceList(value['accessSources']))
  );
}

export function isRunnerProjectScopeDto(value: unknown): value is RunnerProjectScopeDto {
  return (
    isRecord(value) &&
    isRunnerProjectScope(value['projectScope']) &&
    isStringList(value['allowedProjects']) &&
    (value['projectScope'] === 'selected' || value['allowedProjects'].length === 0)
  );
}

const isSlug = (value: unknown): value is string => typeof value === 'string' && isValidSlug(value);

function isRunnerServedProjectDto(value: unknown): value is RunnerServedProjectDto {
  return (
    isRecord(value) && isSlug(value['slug']) && isAccessSource(value['accessSource']) && typeof value['fit'] === 'boolean'
  );
}

/** Narrows the scope a claim carries; the runner holds itself to nothing it did not check. */
export function isRunnerScopeDto(value: unknown): value is RunnerScopeDto {
  if (!isRecord(value) || !isRunnerProjectScopeDto(value)) {
    return false;
  }
  const projects = (value as Record<string, unknown>)['projects'];
  return Array.isArray(projects) && projects.every(isSlug);
}

export function isRunnerSelfDto(value: unknown): value is RunnerSelfDto {
  if (!isRecord(value) || !isRecord(value['runner']) || !Array.isArray(value['projects'])) {
    return false;
  }
  const runner = value['runner'];
  return (
    isRunnerProjectScopeDto(runner) &&
    isRunnerId(runner['id']) &&
    isString(runner['name']) &&
    isUlid(runner['accountId']) &&
    isRunnerIsolation(runner['isolation']) &&
    isRunnerVersion(runner['version']) &&
    typeof runner['belowMinimum'] === 'boolean' &&
    isNullable(runner['pausedUntil'], isTimestamp) &&
    isNullable(runner['lastSeenAt'], isTimestamp) &&
    value['projects'].every(
      (project: unknown) => isRecord(project) && isSlug(project['slug']) && isAccessSource(project['accessSource']),
    )
  );
}

function isRunnerPauseDto(value: unknown): value is RunnerPauseDto {
  return isRecord(value) && isRunnerPauseReason(value['reason']) && isTimestamp(value['until']);
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
    isRunnerProjectScopeDto(value) &&
    Array.isArray(value['servedProjects']) &&
    value['servedProjects'].every(isRunnerServedProjectDto) &&
    isTimestamp(value['enrolledAt']) &&
    isNullable(value['lastSeenAt'], isTimestamp) &&
    isNullable(value['lastSeenCountry'], isString) &&
    typeof value['online'] === 'boolean' &&
    isNullable(value['suspect'], isRunnerSuspectDto) &&
    isNullable(value['revokedAt'], isTimestamp) &&
    typeof value['belowMinimum'] === 'boolean' &&
    isNullable(value['pause'], isRunnerPauseDto) &&
    typeof value['enrolledByYou'] === 'boolean' &&
    isNullable(value['enrolledByName'], isDisplayName)
  );
}

export function isPendingEnrolmentDto(value: unknown): value is PendingEnrolmentDto {
  return (
    isRecord(value) &&
    isEnrolmentId(value['id']) &&
    isString(value['name']) &&
    isRunnerProjectScopeDto(value) &&
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
    isRunnerProjectScopeDto(value)
  );
}
