import { isUlid } from './account';
import { isNullable, isString, isTimestamp } from './guards';
import {
  RUNNER_HOST_FIELD_MAX_LENGTH,
  UNSHOWN_CHARACTER,
  capabilities,
  isEd25519PublicJwk,
  isEnrolmentIsolation,
  isRunnerProjectScopeDto,
  isRunnerVersion,
  projectScopeOf,
  runnerHostOf,
  runnerName,
  type Ed25519PublicJwk,
  type EnrolmentIsolation,
  type RunnerCapabilitiesDto,
  type RunnerHostDto,
  type RunnerProjectScopeDto,
} from './runner';
import { RUNNER_IMAGE, isImageDigest } from './runner-linux';
import {
  MAC_RELEASE_PLATFORMS,
  RUNNER_INSTALLED_LAUNCHER,
  isReleaseVersion,
  type MacReleasePlatform,
} from './runner-release';
import { InputError, checked, isRecord, oneOf, record, text, type InputCheck } from './tracker/inputs';

/**
 * Enrolment intents (#634 PR 3, architect note section 2; threat model C4 R-INT-1…7): the runner's second door, with
 * no secret on the human side. The owner's wizard creates an intent (an id, never a credential), the runner's `setup`
 * binds its public key to it, the owner compares the key's fingerprint and approves, and the runner collects its
 * enrolment with a poll token only it holds. No DTO here has a credential, its kind or its length.
 */

/**
 * What the owner sees. `expired` is the reader's answer for a pending or bound intent past `expiresAt`; the row never
 * stores it (migration 0037).
 */
export const ENROLMENT_INTENT_STATES = [
  'pending',
  'bound',
  'approved',
  'used',
  'expired',
  'withdrawn',
] as const;
export type EnrolmentIntentState = (typeof ENROLMENT_INTENT_STATES)[number];
export const isEnrolmentIntentState = (value: unknown): value is EnrolmentIntentState =>
  (ENROLMENT_INTENT_STATES as readonly unknown[]).includes(value);

/** An intent lives ten minutes, as an enrolment code does. */
export const ENROLMENT_INTENT_TTL_SECONDS = 600;
/** How often the runner polls for the owner's approval; a poll sooner than this is `slow-down`. */
export const ENROLMENT_INTENT_POLL_SECONDS = 5;
/**
 * An approved intent stays collectable this long after the approval even past `expiresAt`, so an approval in the last
 * seconds of the ten minutes still reaches the runner.
 */
export const ENROLMENT_INTENT_COLLECT_SECONDS = 120;
/** Intents of one account that can still be bound or approved at once (R-INT-5). */
export const ENROLMENT_INTENTS_LIVE_MAX = 3;
/** Intents one account may create per hour (R-INT-5). */
export const ENROLMENT_INTENTS_PER_HOUR = 20;

/** An intent's id is a ULID: an identifier, not a credential, so it may sit in argv and in a copied command. */
export function isEnrolmentIntentId(value: unknown): value is string {
  return isUlid(value);
}

const FINGERPRINT = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const FINGERPRINT_BITS = 40;

export function isRunnerKeyFingerprint(value: unknown): value is string {
  return typeof value === 'string' && FINGERPRINT.test(value);
}

/**
 * What the owner compares between the wizard and the terminal (R-INT-1): the first 40 bits of the key's RFC 7638 JWK
 * thumbprint (SHA-256 over `{"crv","kty","x"}` in that order), in Crockford base32 as `ABCD-EFGH`. The runner computes
 * it from its own key and refuses a server answer that differs; the console computes it at the bind.
 */
export async function runnerKeyFingerprintOf(key: Ed25519PublicJwk): Promise<string> {
  const canonical = JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x });
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)));
  let bits = 0n;
  for (const byte of digest.subarray(0, FINGERPRINT_BITS / 8)) {
    bits = (bits << 8n) | BigInt(byte);
  }
  let symbols = '';
  for (let shift = FINGERPRINT_BITS - 5; shift >= 0; shift -= 5) {
    symbols += CROCKFORD.charAt(Number((bits >> BigInt(shift)) & 31n));
  }
  return `${symbols.slice(0, 4)}-${symbols.slice(4)}`;
}

/**
 * `POST /api/v1/accounts/:id/runners/enrolment-intents`. The scope pair follows the enrolment code's rules:
 * `projectScope` defaults to `all`, and `allowedProjects` must be `[]` with `all`.
 */
export interface CreateEnrolmentIntentInput extends RunnerProjectScopeDto {
  readonly name: string;
  readonly isolation: EnrolmentIsolation;
}

/**
 * The verified-download one-liner per Mac processor (#634 PR 5, R-ONE-1): download the named release, check it
 * against the sum the console names, then `setup` as root from a root-owned copy. Built by the API only.
 */
export type RunnerInstallCommandsDto = { readonly version: string } & Readonly<
  Record<MacReleasePlatform, string>
>;

/**
 * The Linux one command (#634 PR 7, R-LNX), both parts built by the API from constants and the attested image digest:
 * `prepare` makes the `tcrunner` user and the two hardened systemd units once (as an admin), `enrol` runs the runner's
 * image interactively as `tcrunner` with the request id in `TC_ENROLMENT` (the API key is typed at its hidden prompt,
 * never passed in) and then starts the service. `image` is the reference both name, by digest.
 */
export interface LinuxInstallCommandsDto {
  readonly version: string;
  readonly image: string;
  readonly prepare: string;
  readonly enrol: string;
}

export interface EnrolmentIntentCreatedDto {
  readonly intentId: string;
  readonly expiresAt: string;
  /**
   * The `setup` invocation for this intent on a Mac where the release is already installed, built by the API from its
   * configured origin. Never absent (#817): when that origin is not configured or not safe to paste, the API makes no
   * intent and answers 503 `console-origin-misconfigured` instead, so the wizard never assembles a command from
   * client state and no unusable intent holds one of the account's open slots.
   */
  readonly command: string;
  /**
   * The first-install one-liners. `null` unless this environment names a release whose sums passed the deploy-time
   * attestation check and the Worker's format check, that release ships its own `node` (S2), and the origin is https.
   */
  readonly installCommands: RunnerInstallCommandsDto | null;
  /**
   * The Linux one command for a `container` intent; `null` for any other isolation, and unless this environment names
   * a release from `LINUX_SETUP_SINCE` on with an image digest that passed the deploy-time attestation check.
   */
  readonly linuxInstall: LinuxInstallCommandsDto | null;
}

/** `GET …/enrolment-intents/:intent`: what the wizard polls. The bind's members are `null` until a runner bound. */
export interface EnrolmentIntentDto extends RunnerProjectScopeDto {
  readonly id: string;
  readonly state: EnrolmentIntentState;
  readonly name: string;
  readonly isolation: EnrolmentIsolation;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly host: RunnerHostDto | null;
  readonly version: string | null;
  readonly fingerprint: string | null;
  readonly boundAt: string | null;
  /** `CF-IPCountry` of the bind (R-INT-1), `null` when the edge named none. */
  readonly boundCountry: string | null;
  /** The runner the approval created; the wizard watches `GET …/runners` for it. */
  readonly runnerId: string | null;
}

/**
 * `GET …/runners/enrolment-intents` (#817): the caller's own open intents (pending or bound, unexpired), newest first
 * and never more than `ENROLMENT_INTENTS_LIVE_MAX`, so the owner can withdraw one the cap holds against them.
 */
export interface EnrolmentIntentListDto {
  readonly intents: readonly EnrolmentIntentDto[];
}

/** `POST …/enrolment-intents/:intent/approve`: the fingerprint the wizard displayed, compared with the bound key. */
export interface ApproveEnrolmentIntentInput {
  readonly fingerprint: string;
}

/**
 * `POST /api/v1/runner/enrol/start`: the runner's half. No account, name or scope: those are the intent row's alone
 * (R-INT-6); `isolation` must equal the intent's.
 */
export interface StartEnrolmentInput {
  readonly intentId: string;
  readonly publicKey: Ed25519PublicJwk;
  readonly host: RunnerHostDto;
  readonly capabilities: RunnerCapabilitiesDto;
  readonly isolation: EnrolmentIsolation;
  readonly version: string;
}

export interface StartEnrolmentResponse {
  /** 256 random bits, returned once; the console keeps its hash. It travels in the poll body only. */
  readonly pollToken: string;
  readonly fingerprint: string;
  readonly intervalSeconds: number;
  readonly expiresAt: string;
  /** The account's display name, for a native confirmation before anything else runs (S3). */
  readonly accountName: string;
}

/** `POST /api/v1/runner/enrol/poll`. */
export interface PollEnrolmentInput {
  readonly intentId: string;
  readonly pollToken: string;
}

/** The 202 of a poll while the owner has not approved yet. */
export interface PollEnrolmentPendingDto {
  readonly state: 'bound';
  readonly intervalSeconds: number;
}

const UNSAFE_HOST_TEXT = UNSHOWN_CHARACTER;
const UNSAFE_TEXT_ALL = new RegExp(UNSHOWN_CHARACTER.source, 'gu');

/** The longest account name `start` returns, in code points; the runner refuses a longer one (R-INT-3). */
export const ENROLMENT_ACCOUNT_NAME_MAX = 64;

/** Whether console text holds a control, format (bidi overrides and isolates among them) or separator character. */
export const hasUnshownText = (value: string): boolean => UNSAFE_HOST_TEXT.test(value);

/**
 * Text for a terminal or a native dialog (R-INT-3, R-INT-7): those characters removed, whitespace collapsed, cut to
 * `max` code points and trimmed. Still untrusted plain text for interpolation only, never markup.
 */
export function shownTextOf(value: string, max: number): string {
  const cleaned = value.replace(UNSAFE_TEXT_ALL, '').replace(/\s+/gu, ' ').trim();
  return [...cleaned].slice(0, max).join('').trim();
}

function intentId(value: unknown): string {
  return oneOf('intentId', value, isEnrolmentIntentId);
}

export function checkCreateEnrolmentIntentInput(body: unknown): InputCheck<CreateEnrolmentIntentInput> {
  return checked(() => {
    const fields = record(body, ['name', 'projectScope', 'allowedProjects', 'isolation']);
    return {
      name: runnerName(fields['name']),
      ...projectScopeOf(fields, true),
      isolation: oneOf('isolation', fields['isolation'], isEnrolmentIsolation),
    };
  });
}

export function checkApproveEnrolmentIntentInput(body: unknown): InputCheck<ApproveEnrolmentIntentInput> {
  return checked(() => {
    const fields = record(body, ['fingerprint']);
    return { fingerprint: oneOf('fingerprint', fields['fingerprint'], isRunnerKeyFingerprint) };
  });
}

/** The bind body: exactly the members of `/runner/enrol` with the intent's id in place of the code. */
export function checkStartEnrolmentInput(body: unknown): InputCheck<StartEnrolmentInput> {
  return checked(() => {
    const fields = record(body, ['intentId', 'publicKey', 'host', 'capabilities', 'isolation', 'version']);
    const publicKey = fields['publicKey'];
    if (!isEd25519PublicJwk(publicKey)) {
      throw new InputError('publicKey', 'publicKey must be an Ed25519 public JWK (kty OKP, crv Ed25519, x)');
    }
    return {
      intentId: intentId(fields['intentId']),
      publicKey: { kty: 'OKP', crv: 'Ed25519', x: publicKey.x },
      // R-INT-7: shown to the owner at approval; `runnerHostOf` refuses control and direction characters.
      host: runnerHostOf(fields['host']),
      capabilities: capabilities(fields['capabilities']),
      isolation: oneOf('isolation', fields['isolation'], isEnrolmentIsolation),
      version: oneOf('version', fields['version'], isRunnerVersion),
    };
  });
}

/**
 * The poll body. The token's shape is checked only loosely (a string of a sane length): whether it is this intent's
 * token is the route's answer, one 404 for every wrong one.
 */
export function checkPollEnrolmentInput(body: unknown): InputCheck<PollEnrolmentInput> {
  return checked(() => {
    const fields = record(body, ['intentId', 'pollToken']);
    return {
      intentId: intentId(fields['intentId']),
      pollToken: text('pollToken', fields['pollToken'], 128, 1),
    };
  });
}

const SETUP_API_URL = /^https?:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/;

/**
 * The `setup` invocation the wizard shows for an intent on a Mac with the release installed, exactly as the runbook
 * spells it: `sudo /usr/local/lib/team-console-runner/bin/team-console-runner setup --url <origin> --enrolment <id>`
 * (sudo's secure_path does not reach the prefix, and as root the launcher runs only the release's own node). The id
 * is an identifier, so it may sit in argv (R-INT-1 covers a local user who reads it there). `null` when either part
 * could carry a shell metacharacter, so a surprising value is never offered for pasting into a terminal.
 */
export function setupCommandOf(apiUrl: string, id: string): string | null {
  if (!SETUP_API_URL.test(apiUrl) || !isEnrolmentIntentId(id)) {
    return null;
  }
  return `sudo ${RUNNER_INSTALLED_LAUNCHER} setup --url ${apiUrl} --enrolment ${id}`;
}

function isShownHost(value: unknown): value is RunnerHostDto {
  return (
    isRecord(value) &&
    [value['os'], value['arch'], value['hostname']].every(
      // The bound is code points at the door; a UTF-16 length is at most twice that.
      (field) =>
        isString(field) && field.length <= RUNNER_HOST_FIELD_MAX_LENGTH * 2 && !UNSAFE_HOST_TEXT.test(field),
    )
  );
}

const COUNTRY = /^[A-Z]{2}$/;

/** Narrows an intent as the Worker answers it; the wizard renders none it did not check. */
export function isEnrolmentIntentDto(value: unknown): value is EnrolmentIntentDto {
  return (
    isRecord(value) &&
    isEnrolmentIntentId(value['id']) &&
    isEnrolmentIntentState(value['state']) &&
    isString(value['name']) &&
    isRunnerProjectScopeDto(value) &&
    isEnrolmentIsolation(value['isolation']) &&
    isTimestamp(value['createdAt']) &&
    isTimestamp(value['expiresAt']) &&
    isNullable(value['host'], isShownHost) &&
    isNullable(value['version'], isRunnerVersion) &&
    isNullable(value['fingerprint'], isRunnerKeyFingerprint) &&
    isNullable(value['boundAt'], isTimestamp) &&
    isNullable(
      value['boundCountry'],
      (country): country is string => isString(country) && COUNTRY.test(country),
    ) &&
    isNullable(value['runnerId'], isUlid)
  );
}

export function isEnrolmentIntentListDto(value: unknown): value is EnrolmentIntentListDto {
  if (!isRecord(value) || !Array.isArray(value['intents'])) {
    return false;
  }
  const intents: readonly unknown[] = value['intents'];
  return intents.length <= ENROLMENT_INTENTS_LIVE_MAX && intents.every(isEnrolmentIntentDto);
}

export function isRunnerInstallCommandsDto(value: unknown): value is RunnerInstallCommandsDto {
  return (
    isRecord(value) &&
    Object.keys(value).length === MAC_RELEASE_PLATFORMS.length + 1 &&
    isReleaseVersion(value['version']) &&
    MAC_RELEASE_PLATFORMS.every((platform) => isString(value[platform]) && value[platform] !== '')
  );
}

export function isLinuxInstallCommandsDto(value: unknown): value is LinuxInstallCommandsDto {
  if (!isRecord(value) || Object.keys(value).length !== 4 || !isReleaseVersion(value['version'])) {
    return false;
  }
  const image = value['image'];
  const prefix = `${RUNNER_IMAGE}:${value['version']}@`;
  return (
    isString(image) &&
    image.startsWith(prefix) &&
    isImageDigest(image.slice(prefix.length)) &&
    isString(value['prepare']) &&
    value['prepare'] !== '' &&
    isString(value['enrol']) &&
    value['enrol'].includes(image)
  );
}

export function isEnrolmentIntentCreatedDto(value: unknown): value is EnrolmentIntentCreatedDto {
  return (
    isRecord(value) &&
    isEnrolmentIntentId(value['intentId']) &&
    isTimestamp(value['expiresAt']) &&
    isString(value['command']) &&
    value['command'] !== '' &&
    isNullable(value['installCommands'], isRunnerInstallCommandsDto) &&
    isNullable(value['linuxInstall'], isLinuxInstallCommandsDto)
  );
}

/** Narrows the bind's answer; the runner trusts no member it did not check, and compares the fingerprint itself. */
export function isStartEnrolmentResponse(value: unknown): value is StartEnrolmentResponse {
  return (
    isRecord(value) &&
    isString(value['pollToken']) &&
    isRunnerKeyFingerprint(value['fingerprint']) &&
    typeof value['intervalSeconds'] === 'number' &&
    Number.isInteger(value['intervalSeconds']) &&
    value['intervalSeconds'] > 0 &&
    isTimestamp(value['expiresAt']) &&
    isString(value['accountName'])
  );
}

export function isPollEnrolmentPendingDto(value: unknown): value is PollEnrolmentPendingDto {
  return (
    isRecord(value) &&
    value['state'] === 'bound' &&
    typeof value['intervalSeconds'] === 'number' &&
    Number.isInteger(value['intervalSeconds']) &&
    value['intervalSeconds'] > 0
  );
}
