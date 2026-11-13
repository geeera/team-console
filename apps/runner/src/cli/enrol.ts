import { join } from 'node:path';
import { ENROLMENT_CODE_PREFIX, OPAQUE_TOKEN_TAIL } from '@shared/redaction';
import type { EnrolRunnerInput, RunnerHostDto } from '@shared/contracts';
import { postEnrolment } from '../client/enrolment';
import type { FetchLike } from '../client/runner-client';
import {
  CONFIG_SCHEMA_VERSION,
  PINNED_IMAGE,
  apiOriginOf,
  configPathOf,
  isEnrolBackend,
  parseRunnerConfig,
  runnerKeyPathOf,
  saveRunnerConfig,
  type EnrolBackend,
  type RunnerConfig,
} from '../config/config';
import { RunnerFileError, ensurePrivateDir, pathExists } from '../config/private-files';
import {
  CREDENTIALS_DIR,
  CREDENTIAL_BACKENDS,
  parseCredentialConfig,
  type CredentialConfig,
  type CredentialKind,
} from '../env/credential';
import { generateRunnerKey, saveRunnerKey } from '../config/runner-key';
import { RUNNER_VERSION } from '../version';

/**
 * `team-console-runner enrol --url <origin> --code <tce_…> --backend container|user|none` (ADR 0006 "Enrolment",
 * the command Settings › Runners shows, `enrolCommandOf`): a fresh Ed25519 key on this host, the public half and the
 * host's description posted with the one-time code, and on success the key (0600) and `config.json` (0600) written
 * under `TC_RUNNER_HOME`. Nothing is written before the console accepts, and an enrolled home is never overwritten.
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
  readonly code: string;
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
}

export interface EnrolCheckedOptions {
  readonly apiUrl: string;
  readonly code: string;
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

/** Validates the flags before anything touches the disk or the network; the code is never echoed back. */
export function checkEnrolOptions(options: EnrolOptions): EnrolCheckedOptions {
  const apiUrl = apiOriginOf(options.url);
  if (apiUrl === null) {
    throw new EnrolUsageError('--url must be the console origin, https://… (http only for a loopback host)');
  }
  if (!ENROLMENT_CODE.test(options.code)) {
    throw new EnrolUsageError(
      `--code must be the one-time ${ENROLMENT_CODE_PREFIX}… code from Settings › Runners`,
    );
  }
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
    code: options.code,
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
  for (const existing of [configPathOf(deps.home), runnerKeyPathOf(deps.home)]) {
    if (await pathExists(existing)) {
      throw new RunnerFileError(
        'file-exists',
        `${existing} exists: this home is already enrolled. Revoke the runner on Settings › Runners and remove the home, or set TC_RUNNER_HOME to a new directory`,
      );
    }
  }

  const key = generateRunnerKey();
  const input: EnrolRunnerInput = {
    code: checked.code,
    publicKey: key.publicJwk,
    host: {
      os: hostFieldOf(deps.host.os),
      arch: hostFieldOf(deps.host.arch),
      hostname: hostFieldOf(deps.host.hostname),
    },
    // `user` runs jobs one at a time on one job uid (ADR 0006); the console enforces it at claim (2-B-4).
    capabilities: { local: true, maxConcurrency: 1 },
    isolation: checked.backend,
    version: RUNNER_VERSION,
  };
  const enrolled = await postEnrolment(checked.apiUrl, input, deps.fetch);

  // Judged before anything is written, so a surprising answer leaves the home as it was.
  const config = parseRunnerConfig({
    schema: CONFIG_SCHEMA_VERSION,
    apiUrl: checked.apiUrl,
    runnerId: enrolled.runnerId,
    accountId: enrolled.accountId,
    name: enrolled.name,
    audience: enrolled.audience,
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
  await saveRunnerKey(deps.home, key.privateKey);
  await saveRunnerConfig(deps.home, config);
  return config;
}
