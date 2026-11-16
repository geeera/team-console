import { join } from 'node:path';
import type { RunnerIsolation } from '@shared/contracts';
import { RunnerFileError, assertPrivateDir, readPrivateFile } from '../config/private-files';
import { LaunchRefusal } from '../jobs/refusal';

/**
 * The Claude credential a job runs with (ADR 0008 decision 5, RR11): one kind per runner, each allowed on named
 * backends only. The runner reads a file kind itself and hands the value to the job's env only; the console never
 * learns which kind is configured, and no value is ever posted or logged.
 */

/**
 * The one variable an `actions-ephemeral` run reads its inference key from: the GitHub Environment secret of that name
 * (owner decision 3 on #573), handed to the runner's process by the workflow and never written to its home.
 */
export const INFERENCE_API_KEY_ENV = 'TC_INFERENCE_API_KEY';

export type CredentialConfig =
  | { readonly kind: 'api-key'; readonly file: string }
  | { readonly kind: 'api-key'; readonly env: typeof INFERENCE_API_KEY_ENV }
  | { readonly kind: 'setup-token'; readonly file: string }
  | { readonly kind: 'claude-config-dir'; readonly path: string };
export type CredentialKind = CredentialConfig['kind'];

/** Which backend may use which kind; any other pairing is refused at every launch. */
export const CREDENTIAL_BACKENDS: Readonly<Record<CredentialKind, readonly RunnerIsolation[]>> = {
  'api-key': ['none', 'user', 'container', 'actions-ephemeral'],
  'setup-token': ['user'],
  'claude-config-dir': ['container'],
};

/** Where a credential's value comes from: the runner's env on `actions-ephemeral` only, a file or path everywhere else. */
const isFromEnv = (credential: CredentialConfig): credential is Extract<CredentialConfig, { env: string }> =>
  'env' in credential;

/**
 * The pairing rule of decision 5 plus the source rule of #669: an `actions-ephemeral` run has no home to keep a file
 * in, so it takes the key from its env alone; a host runner never reads a credential from its env.
 */
export function isCredentialAllowed(credential: CredentialConfig, backend: RunnerIsolation): boolean {
  return CREDENTIAL_BACKENDS[credential.kind].includes(backend) && isFromEnv(credential) === (backend === 'actions-ephemeral');
}

/** Kinds that carry a Claude subscription (OAuth) login; never on a hosted or Actions job. */
export const OAUTH_CREDENTIAL_KINDS: readonly CredentialKind[] = ['setup-token', 'claude-config-dir'];

/** The variable each kind sets in the job; also the only place these names may come from (decision 4). */
export const CREDENTIAL_VARIABLES: Readonly<Record<CredentialKind, string>> = {
  'api-key': 'ANTHROPIC_API_KEY',
  'setup-token': 'CLAUDE_CODE_OAUTH_TOKEN',
  'claude-config-dir': 'CLAUDE_CONFIG_DIR',
};

export const CREDENTIALS_DIR = 'credentials';
/** Where the `container` backend mounts a `claude-config-dir` read-only (2-B-3). */
export const CONTAINER_CLAUDE_CONFIG_DIR = '/home/job/.claude';
const CREDENTIAL_FILE = /^credentials\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CREDENTIAL_VALUE = /^[\x21-\x7e]{8,4096}$/;

export interface JobCredential {
  readonly kind: CredentialKind;
  readonly name: string;
  readonly value: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Narrows `config.credential`; `null` when the value is not one of the four shapes. */
export function parseCredentialConfig(value: unknown): CredentialConfig | null {
  if (!isRecord(value)) {
    return null;
  }
  const keys = Object.keys(value).sort().join(',');
  const { kind, file, path, env } = value;
  if (kind === 'api-key' && keys === 'env,kind') {
    return env === INFERENCE_API_KEY_ENV ? { kind, env } : null;
  }
  if ((kind === 'api-key' || kind === 'setup-token') && keys === 'file,kind') {
    if (typeof file !== 'string' || !CREDENTIAL_FILE.test(file)) {
      return null;
    }
    return kind === 'api-key' ? { kind, file } : { kind, file };
  }
  if (kind === 'claude-config-dir' && keys === 'kind,path') {
    return typeof path === 'string' && path.startsWith('/') && !path.split('/').includes('..')
      ? { kind, path }
      : null;
  }
  return null;
}

/** What a refusal says about the pairing: the source too, since an env key and a file key share a kind. */
const describeCredential = (credential: CredentialConfig): string =>
  isFromEnv(credential) ? `${credential.kind} credential from ${credential.env}` : `${credential.kind} credential`;

export function assertCredentialAllowed(credential: CredentialConfig, backend: RunnerIsolation): void {
  if (!isCredentialAllowed(credential, backend)) {
    throw new LaunchRefusal(
      'credential-not-allowed',
      `the ${describeCredential(credential)} is not allowed on the ${backend} backend`,
    );
  }
}

/**
 * The one credential variable of the job, read fresh per launch; `null` when none is configured. `source` is the
 * runner's own env, read for an env credential only; its value goes into the job's env and nowhere else.
 */
export async function jobCredentialOf(
  home: string,
  credential: CredentialConfig | undefined,
  backend: RunnerIsolation,
  source: Readonly<Record<string, string | undefined>> = {},
): Promise<JobCredential | null> {
  if (credential === undefined) {
    return null;
  }
  assertCredentialAllowed(credential, backend);
  const name = CREDENTIAL_VARIABLES[credential.kind];
  if (credential.kind === 'claude-config-dir') {
    // The runner never opens the directory; the container backend mounts it read-only.
    return { kind: credential.kind, name, value: CONTAINER_CLAUDE_CONFIG_DIR };
  }
  if (isFromEnv(credential)) {
    const value = source[credential.env]?.trim() ?? '';
    if (!CREDENTIAL_VALUE.test(value)) {
      throw new LaunchRefusal('credential-unreadable', `${credential.env} does not hold one credential line`);
    }
    return { kind: credential.kind, name, value };
  }
  let value: string;
  try {
    await assertPrivateDir(join(home, CREDENTIALS_DIR));
    value = (await readPrivateFile(join(home, credential.file))).trim();
  } catch (error: unknown) {
    if (error instanceof RunnerFileError) {
      throw new LaunchRefusal('credential-unreadable', `${credential.file}: ${error.problem}`);
    }
    throw error;
  }
  if (!CREDENTIAL_VALUE.test(value)) {
    throw new LaunchRefusal('credential-unreadable', `${credential.file} does not hold one credential line`);
  }
  return { kind: credential.kind, name, value };
}
