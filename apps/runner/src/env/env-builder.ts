import type { AccessSource, JobDispatch } from '@shared/contracts';
import { LaunchRefusal } from '../jobs/refusal';
import {
  CREDENTIAL_VARIABLES,
  OAUTH_CREDENTIAL_KINDS,
  assertCredentialMatchesSource,
  type JobCredential,
} from './credential';

/**
 * The job's environment, built from nothing (ADR 0008 decision 4, threat model C3 cross-job row (a)): no variable of
 * the runner's own process reaches the job except the allow-listed passthrough names, and those never carry a
 * credential. The `none` backend spawns with exactly this object.
 */

/** `TC_API_URL` is HTTP over the job's socket; the host part is a placeholder the socket ignores. */
export const JOB_API_URL = 'http://tc/api/v1';
export const DEFAULT_TOOLCHAIN_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';
const JOB_LANG = 'en_US.UTF-8';
const JOB_TZ = 'UTC';

/**
 * Passthrough names that could smuggle a credential in, hand the job the runner's ssh agent, or inject code into
 * the CLI's own process; each a refusal with `metrics.reason`.
 */
export const REFUSED_PASSTHROUGH: readonly {
  readonly label: string;
  readonly test: (name: string) => boolean;
}[] = [
  { label: '*_API_KEY', test: (name) => name.endsWith('_API_KEY') },
  { label: '*_KEY', test: (name) => name.endsWith('_KEY') },
  { label: '*_TOKEN', test: (name) => name.endsWith('_TOKEN') },
  { label: '*_PAT', test: (name) => name.endsWith('_PAT') },
  { label: '*_PASSWORD', test: (name) => name.endsWith('_PASSWORD') },
  { label: '*SECRET*', test: (name) => name.includes('SECRET') },
  { label: '*CREDENTIAL*', test: (name) => name.includes('CREDENTIAL') },
  { label: 'SSH_AUTH_SOCK', test: (name) => name === 'SSH_AUTH_SOCK' },
  { label: 'NODE_OPTIONS', test: (name) => name === 'NODE_OPTIONS' },
  { label: 'DYLD_*', test: (name) => name.startsWith('DYLD_') },
  // The Linux form of DYLD_*, for the container backend.
  { label: 'LD_*', test: (name) => name.startsWith('LD_') },
  { label: 'ANTHROPIC_*', test: (name) => name.startsWith('ANTHROPIC_') },
  { label: 'CLAUDE_*', test: (name) => name.startsWith('CLAUDE_') },
  { label: 'TC_*', test: (name) => name.startsWith('TC_') },
];

/**
 * What a job of each access source never gets (ADR 0009 T7), whatever put it there: an `api_key` job no Claude login,
 * a `subscription` job no API key, auth token or endpoint override that would move its billing to an API account.
 */
export const STRIPPED_BY_SOURCE: Readonly<Record<AccessSource, readonly string[]>> = {
  api_key: ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR'],
  subscription: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'],
};

const PASSTHROUGH_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

export interface JobEnvInput {
  readonly jobToken: string;
  readonly projectSlug: string;
  readonly consoleUrl: string;
  readonly socketPath: string;
  readonly home: string;
  readonly tmp: string;
  readonly toolchainPath: string;
  readonly dispatch: JobDispatch;
  readonly credential: JobCredential | null;
  /** The claim's `access.source`; `null` for a claim without a team configuration (an older console). */
  readonly accessSource: AccessSource | null;
  readonly passthrough: readonly string[];
  /** The runner's own environment; read for the passthrough names only. */
  readonly source: Readonly<Record<string, string | undefined>>;
}

export interface JobEnv {
  readonly env: Readonly<Record<string, string>>;
  /** Passthrough names that were set; every job using one gets a `notice` (retired in 3b). */
  readonly passedThrough: readonly string[];
}

export function buildJobEnv(input: JobEnvInput): JobEnv {
  const env: Record<string, string> = {
    TC_API_URL: JOB_API_URL,
    TC_RUNNER_SOCKET: input.socketPath,
    TC_JOB_TOKEN: input.jobToken,
    TC_PROJECT: input.projectSlug,
    TC_CONSOLE_URL: input.consoleUrl,
    HOME: input.home,
    TMPDIR: input.tmp,
    PATH: input.toolchainPath,
    LANG: JOB_LANG,
    TZ: JOB_TZ,
    DISABLE_AUTOUPDATER: '1',
  };

  const passedThrough: string[] = [];
  for (const name of input.passthrough) {
    const refused = REFUSED_PASSTHROUGH.find((rule) => rule.test(name));
    if (refused !== undefined || !PASSTHROUGH_NAME.test(name) || name in env) {
      throw new LaunchRefusal(
        'env-passthrough-refused',
        `passthrough ${name} is refused${refused === undefined ? '' : ` (${refused.label})`}`,
      );
    }
    const value = input.source[name];
    if (value !== undefined) {
      env[name] = value;
      passedThrough.push(name);
    }
  }

  const { credential, accessSource } = input;
  if (accessSource !== null) {
    assertCredentialMatchesSource(credential?.kind ?? null, accessSource);
  }
  if (credential !== null) {
    if (credential.name !== CREDENTIAL_VARIABLES[credential.kind]) {
      throw new LaunchRefusal(
        'credential-not-allowed',
        `${credential.name} is not the ${credential.kind} variable`,
      );
    }
    if (OAUTH_CREDENTIAL_KINDS.includes(credential.kind) && input.dispatch !== 'pull') {
      throw new LaunchRefusal(
        'oauth-on-hosted',
        `a Claude subscription credential never runs a ${input.dispatch} job`,
      );
    }
    env[credential.name] = credential.value;
  }
  if (accessSource !== null) {
    for (const name of STRIPPED_BY_SOURCE[accessSource]) {
      delete env[name];
    }
  }
  return { env, passedThrough };
}

/** The runner check's environment (#1059, S6). */
export interface CheckEnv {
  readonly PATH: string;
  readonly HOME: string;
  readonly TMPDIR: string;
  readonly DISABLE_AUTOUPDATER: '1';
  readonly CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1';
}

/**
 * A runner check's environment (#1059, S6/T7), built from nothing and with no passthrough: the toolchain's PATH, the
 * sandbox HOME and TMPDIR, and the two switches that stop Claude Code updating itself or calling home during the
 * probe. No `TC_*`, no console URL, no credential variable.
 */
export function buildCheckEnv(input: { readonly path: string; readonly home: string; readonly tmp: string }): CheckEnv {
  return {
    PATH: input.path,
    HOME: input.home,
    TMPDIR: input.tmp,
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
}
