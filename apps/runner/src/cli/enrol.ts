import { join } from 'node:path';
import { ENROLMENT_CODE_PREFIX, OPAQUE_TOKEN_TAIL } from '@shared/redaction';
import {
  ENROLMENT_ACCOUNT_NAME_MAX,
  ENROLMENT_INTENT_COLLECT_SECONDS,
  hasUnshownText,
  isEnrolmentIntentId,
  runnerKeyFingerprintOf,
  type EnrolRunnerInput,
  type EnrolRunnerResponse,
  type Ed25519PublicJwk,
  type RunnerHostDto,
} from '@shared/contracts';
import { pollEnrolment, postEnrolment, startEnrolment } from '../client/enrolment';
import { RunnerApiError, type FetchLike } from '../client/runner-client';
import {
  CONFIG_SCHEMA_VERSION,
  PINNED_IMAGE,
  apiOriginOf,
  configPathOf,
  isEnrolBackend,
  parseRunnerConfig,
  saveRunnerConfig,
  type EnrolBackend,
  type RunnerConfig,
} from '../config/config';
import { isBuiltInConsoleOrigin } from '../config/console-origins';
import { RunnerFileError, ensurePrivateDir, pathExists } from '../config/private-files';
import {
  CREDENTIALS_DIR,
  CREDENTIAL_BACKENDS,
  accessSourcesOf,
  parseCredentialConfig,
  type CredentialConfig,
  type CredentialKind,
} from '../env/credential';
import {
  generateRunnerKey,
  runnerKeyLocationOf,
  saveRunnerKey,
  type RunnerKeyDeps,
} from '../config/runner-key';
import { RUNNER_VERSION } from '../version';

/**
 * `TC_ENROL_CODE=<tce_…> team-console-runner enrol --url <origin> --backend container|user|none` (ADR 0006
 * "Enrolment", the command Settings › Runners shows, `enrolCommandOf`; where the code may come from is
 * `enrol-code.ts`): a fresh Ed25519 key on this host, the public half and the
 * host's description posted with the one-time code, and on success the key (a keychain item or a 0600 file, see
 * `runner-key.ts`) and `config.json` (0600) under `TC_RUNNER_HOME`. Nothing is written before the console accepts, and an enrolled home is never overwritten.
 */

const ENROLMENT_CODE = new RegExp(`^${ENROLMENT_CODE_PREFIX}${OPAQUE_TOKEN_TAIL}$`);
const HOST_FIELD_MAX = 128;

export class EnrolUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnrolUsageError';
  }
}

export interface EnrolOptions {
  readonly url: string;
  /** Exactly one of the two doors: the one-time `tce_…` code, or the id of the owner's enrolment intent (#634). */
  readonly code?: string | undefined;
  readonly enrolment?: string | undefined;
  readonly backend: string;
  /** `api-key`, `setup-token` (user only) or `claude-config-dir` (container only); decision 5. */
  readonly credential?: string | undefined;
  readonly claudeConfigDir?: string | undefined;
  /** `container` only: the runner image pinned by digest. */
  readonly image?: string | undefined;
}

/** Where each file kind's credential lives under `TC_RUNNER_HOME`; the operator puts the value there (0600). */
export const CREDENTIAL_FILES: Readonly<Record<'api-key' | 'setup-token', string>> = {
  'api-key': `${CREDENTIALS_DIR}/anthropic.key`,
  'setup-token': `${CREDENTIALS_DIR}/claude-setup-token`,
};

export interface EnrolDeps {
  readonly home: string;
  readonly fetch: FetchLike;
  readonly host: RunnerHostDto;
  /** Where the key is stored; the host's keychain or file when absent. */
  readonly keys?: RunnerKeyDeps;
  /** The intent door's lines for the operator: the console's origin, its account name and the fingerprint to compare. */
  readonly out?: (line: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
}

export type EnrolDoor =
  { readonly kind: 'code'; readonly code: string } | { readonly kind: 'intent'; readonly intentId: string };

export interface EnrolCheckedOptions {
  readonly apiUrl: string;
  readonly door: EnrolDoor;
  readonly backend: EnrolBackend;
  readonly credential?: CredentialConfig;
  readonly image?: string;
}

const isCredentialKind = (value: string): value is CredentialKind =>
  Object.hasOwn(CREDENTIAL_BACKENDS, value);

/** RR11: a pairing decision 5 does not allow is refused here, before the code is spent. */
function checkCredential(options: EnrolOptions, backend: EnrolBackend): CredentialConfig | undefined {
  const { credential: kind, claudeConfigDir } = options;
  if (kind === undefined) {
    if (claudeConfigDir !== undefined) {
      throw new EnrolUsageError('--claude-config-dir needs --credential claude-config-dir');
    }
    return undefined;
  }
  if (!isCredentialKind(kind)) {
    throw new EnrolUsageError('--credential must be api-key, setup-token or claude-config-dir');
  }
  if (!CREDENTIAL_BACKENDS[kind].includes(backend)) {
    throw new EnrolUsageError(
      `--credential ${kind} is not allowed with --backend ${backend} (allowed: ${CREDENTIAL_BACKENDS[kind].join(', ')})`,
    );
  }
  const parsed = parseCredentialConfig(
    kind === 'claude-config-dir' ? { kind, path: claudeConfigDir } : { kind, file: CREDENTIAL_FILES[kind] },
  );
  if (parsed === null || (kind !== 'claude-config-dir' && claudeConfigDir !== undefined)) {
    throw new EnrolUsageError(
      '--credential claude-config-dir needs --claude-config-dir <absolute path>, and only it',
    );
  }
  return parsed;
}

function doorOf(options: EnrolOptions): EnrolDoor {
  if ((options.code === undefined) === (options.enrolment === undefined)) {
    throw new EnrolUsageError(
      'enrol takes either the one-time code or --enrolment <request id>, not both or neither',
    );
  }
  if (options.enrolment !== undefined) {
    if (!isEnrolmentIntentId(options.enrolment)) {
      throw new EnrolUsageError('--enrolment must be the request id the console showed (26 characters)');
    }
    return { kind: 'intent', intentId: options.enrolment };
  }
  if (options.code === undefined || !ENROLMENT_CODE.test(options.code)) {
    throw new EnrolUsageError(
      `the code must be the one-time ${ENROLMENT_CODE_PREFIX}… code from Settings › Runners`,
    );
  }
  return { kind: 'code', code: options.code };
}

/** Validates the flags before anything touches the disk or the network; the code is never echoed back. */
export function checkEnrolOptions(options: EnrolOptions): EnrolCheckedOptions {
  const apiUrl = apiOriginOf(options.url);
  if (apiUrl === null) {
    throw new EnrolUsageError('--url must be the console origin, https://… (http only for a loopback host)');
  }
  const door = doorOf(options);
  if (!isEnrolBackend(options.backend)) {
    throw new EnrolUsageError('--backend must be container, user or none');
  }
  const credential = checkCredential(options, options.backend);
  if (options.image !== undefined && (options.backend !== 'container' || !PINNED_IMAGE.test(options.image))) {
    throw new EnrolUsageError(
      '--image is for --backend container and must be pinned by digest (<name>@sha256:…)',
    );
  }
  return {
    apiUrl,
    door,
    backend: options.backend,
    ...(credential === undefined ? {} : { credential }),
    ...(options.image === undefined ? {} : { image: options.image }),
  };
}

export function hostFieldOf(value: string): string {
  const trimmed = value.trim().slice(0, HOST_FIELD_MAX);
  return trimmed === '' ? 'unknown' : trimmed;
}

export async function enrol(options: EnrolOptions, deps: EnrolDeps): Promise<RunnerConfig> {
  const checked = checkEnrolOptions(options);
  await ensurePrivateDir(deps.home);
  // The keychain is asked too: an item left behind by a removed home would otherwise refuse only after the code is spent.
  const existing = (await pathExists(configPathOf(deps.home)))
    ? configPathOf(deps.home)
    : await runnerKeyLocationOf(deps.home, deps.keys);
  if (existing !== null) {
    throw new RunnerFileError(
      'file-exists',
      `${existing} exists: this home is already enrolled. Revoke the runner on Settings › Runners and remove the home (and its keychain item, see the runbook), or set TC_RUNNER_HOME to a new directory`,
    );
  }

  const key = generateRunnerKey();
  const described = {
    publicKey: key.publicJwk,
    host: {
      os: hostFieldOf(deps.host.os),
      arch: hostFieldOf(deps.host.arch),
      hostname: hostFieldOf(deps.host.hostname),
    },
    // `user` runs jobs one at a time on one job uid (ADR 0006); the console enforces it at claim (2-B-4). What the
    // credential serves is declared as an enum (#775), never as its kind or value.
    capabilities: { local: true, maxConcurrency: 1, accessSources: accessSourcesOf(checked.credential) },
    isolation: checked.backend,
    version: RUNNER_VERSION,
  } satisfies Omit<EnrolRunnerInput, 'code'>;
  const enrolled =
    checked.door.kind === 'code'
      ? await postEnrolment(checked.apiUrl, { code: checked.door.code, ...described }, deps.fetch)
      : await enrolByIntent(checked.apiUrl, checked.door.intentId, described, deps);

  // Judged before anything is written, so a surprising answer leaves the home as it was.
  const config = parseRunnerConfig({
    schema: CONFIG_SCHEMA_VERSION,
    apiUrl: checked.apiUrl,
    runnerId: enrolled.runnerId,
    accountId: enrolled.accountId,
    name: enrolled.name,
    audience: enrolled.audience,
    projectScope: enrolled.projectScope,
    allowedProjects: enrolled.allowedProjects,
    pollSeconds: enrolled.pollSeconds,
    backend: checked.backend,
    ...(checked.credential === undefined ? {} : { credential: checked.credential }),
    ...(checked.image === undefined ? {} : { container: { image: checked.image } }),
  } satisfies RunnerConfig);
  if (checked.credential !== undefined && checked.credential.kind !== 'claude-config-dir') {
    await ensurePrivateDir(join(deps.home, CREDENTIALS_DIR));
  }
  // The key first: a config without its key would look enrolled and fail every call.
  await saveRunnerKey(deps.home, key.privateKey, deps.keys);
  await saveRunnerConfig(deps.home, config);
  return config;
}

/** Refusals of the intent door, worded for the operator at the terminal. */
export class EnrolIntentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnrolIntentError';
  }
}

/**
 * The console's identity on the confirmation (R-INT-3): the origin this runner talks to, said to be one compiled into
 * it or loudly not. A rogue console chooses its account name, so the name never stands for the console.
 */
export function consoleLineOf(apiUrl: string): string {
  return isBuiltInConsoleOrigin(apiUrl)
    ? `Console: ${apiUrl} (built into this runner).`
    : `Console: ${apiUrl}. THIS IS NOT A CONSOLE BUILT INTO THIS RUNNER: stop (Ctrl-C) unless you run it yourself.`;
}

/**
 * The account name `start` returned, judged as untrusted console text (R-INT-3, as R-INT-7 judges host fields): one
 * with a control, bidi or separator character, blank or longer than the console ever sends is refused, never
 * cleaned up, because only a console that is not ours sends one.
 */
function accountNameOf(value: string): string {
  if (hasUnshownText(value) || value.trim() === '' || [...value].length > ENROLMENT_ACCOUNT_NAME_MAX) {
    throw new EnrolIntentError(
      'the console sent an account name with control or direction characters: do not approve; press «Отклонить» (Reject) in the console, and check the --url you were given',
    );
  }
  return value;
}

const sleepFor = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function intentRefusalOf(error: unknown): never {
  if (error instanceof RunnerApiError) {
    switch (error.problem) {
      case 'enrolment-intent-bound':
        // R-INT-1: someone else bound first; the owner must not approve that request.
        throw new EnrolIntentError(
          'THIS REQUEST IS ALREADY TAKEN BY ANOTHER MACHINE. Press «Отклонить» (Reject) in the console, then start again with a new command.',
        );
      case 'enrolment-not-found':
        throw new EnrolIntentError(
          'the console does not know this request any more (expired, rejected or already used): start again from Settings › Runners › Add runner',
        );
      case 'enrolment-isolation-mismatch':
        throw new EnrolIntentError(
          'this request was made in the console for another backend; start again with the right one',
        );
    }
  }
  throw error;
}

/**
 * The intent door (#634, architect note section 2, R-INT-1): bind this key to the owner's request, check that the
 * console names the fingerprint this host computes from its own key, show it for the owner to compare, then poll
 * until the owner approved. Nothing is written before the answer, as with a code.
 */
async function enrolByIntent(
  apiUrl: string,
  intentId: string,
  described: Omit<EnrolRunnerInput, 'code'> & { readonly publicKey: Ed25519PublicJwk },
  deps: EnrolDeps,
): Promise<EnrolRunnerResponse> {
  const out = deps.out ?? ((): void => undefined);
  const sleep = deps.sleep ?? sleepFor;
  const now = deps.now ?? ((): Date => new Date());
  out(consoleLineOf(apiUrl));
  const start = await startEnrolment(apiUrl, { intentId, ...described }, deps.fetch).catch(intentRefusalOf);
  const accountName = accountNameOf(start.accountName);
  const fingerprint = await runnerKeyFingerprintOf(described.publicKey);
  if (start.fingerprint !== fingerprint) {
    throw new EnrolIntentError(
      `the console names another key (${start.fingerprint}) than this machine's (${fingerprint}): do not approve; press «Отклонить» (Reject) in the console`,
    );
  }
  out(
    `Request sent to the account that console names «${accountName}» (its text, not checked by this runner).`,
  );
  out(
    `Compare this code with the one in the console, then press «Подтвердить» (Approve) there: ${fingerprint}`,
  );
  const deadline = Date.parse(start.expiresAt) + ENROLMENT_INTENT_COLLECT_SECONDS * 1000;
  let interval = start.intervalSeconds;
  for (;;) {
    await sleep(interval * 1000);
    if (now().getTime() > deadline) {
      throw new EnrolIntentError(
        'the request expired before it was approved: start again from Settings › Runners › Add runner',
      );
    }
    try {
      const outcome = await pollEnrolment(apiUrl, { intentId, pollToken: start.pollToken }, deps.fetch);
      if (outcome.kind === 'enrolled') {
        return outcome.enrolment;
      }
      interval = outcome.intervalSeconds;
    } catch (error: unknown) {
      if (error instanceof RunnerApiError && error.problem === 'slow-down') {
        continue;
      }
      if (error instanceof RunnerApiError && error.problem === 'enrolment-not-found') {
        throw new EnrolIntentError(
          'the request was rejected in the console, expired or was already used: nothing was written; start again from Settings › Runners › Add runner',
        );
      }
      throw error;
    }
  }
}
