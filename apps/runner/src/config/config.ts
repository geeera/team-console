import { isAbsolute, join } from 'node:path';
import { isRunnerId, isUlid, isValidSlug, type RunnerIsolation } from '@shared/contracts';
import { RunnerFileError, assertPrivateDir, readPrivateFile, writePrivateFile } from './private-files';

/**
 * The runner's own state (ADR 0008 decision 2): `TC_RUNNER_HOME` (default `~/.team-console-runner`) holding
 * `config.json` 0600 and `keys/runner.key` 0600, nothing of it inside a git worktree. `config.json` carries no
 * secret: the runner id, its account, the console's origin and audience, the backend chosen at `enrol`.
 */

export const RUNNER_HOME_ENV = 'TC_RUNNER_HOME';
export const DEFAULT_RUNNER_HOME_DIR = '.team-console-runner';
export const CONFIG_FILE = 'config.json';
export const KEYS_DIR = 'keys';
export const RUNNER_KEY_FILE = 'runner.key';
export const CONFIG_SCHEMA_VERSION = 1;

/**
 * The backends `enrol --backend` accepts. `actions-ephemeral` is implied by the OIDC exchange of a GitHub Actions
 * run (2-B-6), never chosen on a host.
 */
export const ENROL_BACKENDS = ['container', 'user', 'none'] as const satisfies readonly RunnerIsolation[];
export type EnrolBackend = (typeof ENROL_BACKENDS)[number];
export const isEnrolBackend = (value: unknown): value is EnrolBackend =>
  (ENROL_BACKENDS as readonly unknown[]).includes(value);

export interface RunnerConfig {
  readonly schema: typeof CONFIG_SCHEMA_VERSION;
  /** The console's origin, `https://…` (plain `http` only on a loopback host, for local stacks). */
  readonly apiUrl: string;
  readonly runnerId: string;
  readonly accountId: string;
  readonly name: string;
  /** The `aud` every runner JWT carries (`team-console:<env>`), as the console answered at enrolment. */
  readonly audience: string;
  readonly allowedProjects: readonly string[];
  readonly pollSeconds: number;
  readonly backend: EnrolBackend;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const AUDIENCE = /^team-console:[a-z][a-z0-9-]{0,31}$/;

/**
 * The console origin a runner may talk to, or `null`: `https`, or `http` on a loopback host only, so a runner JWT
 * never crosses a network in clear. An origin only: no credentials, path, query or fragment.
 */
export function apiOriginOf(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // An unparsable URL is an answer here (`null`), not a failure to report.
    return null;
  }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
  if (!secure || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    return null;
  }
  if (url.pathname !== '/' || !/^https?:\/\/[^/]+\/?$/.test(value)) {
    return null;
  }
  return url.origin;
}

/** `TC_RUNNER_HOME` when set (an absolute path), else `<home>/.team-console-runner`. */
export function runnerHomeOf(env: Readonly<Record<string, string | undefined>>, homeDir: string): string {
  const configured = env[RUNNER_HOME_ENV];
  if (configured !== undefined && configured !== '') {
    if (!isAbsolute(configured)) {
      throw new RunnerFileError('home-relative', `${RUNNER_HOME_ENV} must be an absolute path`);
    }
    return configured;
  }
  return join(homeDir, DEFAULT_RUNNER_HOME_DIR);
}

export const configPathOf = (home: string): string => join(home, CONFIG_FILE);
export const keysDirOf = (home: string): string => join(home, KEYS_DIR);
export const runnerKeyPathOf = (home: string): string => join(keysDirOf(home), RUNNER_KEY_FILE);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(detail: string): RunnerFileError {
  return new RunnerFileError('config-invalid', `config.json: ${detail}`);
}

const CONFIG_KEYS = [
  'schema',
  'apiUrl',
  'runnerId',
  'accountId',
  'name',
  'audience',
  'allowedProjects',
  'pollSeconds',
  'backend',
] as const;

/** Narrows `config.json`; an unknown key or a wrong value is refused rather than ignored. */
export function parseRunnerConfig(value: unknown): RunnerConfig {
  if (!isRecord(value)) {
    throw invalid('must be a JSON object');
  }
  const unknownKey = Object.keys(value).find((key) => !(CONFIG_KEYS as readonly string[]).includes(key));
  if (unknownKey !== undefined) {
    throw invalid(`unknown key "${unknownKey}"`);
  }
  const { schema, apiUrl, runnerId, accountId, name, audience, allowedProjects, pollSeconds, backend } =
    value;
  if (schema !== CONFIG_SCHEMA_VERSION) {
    throw invalid(`schema must be ${String(CONFIG_SCHEMA_VERSION)}`);
  }
  if (typeof apiUrl !== 'string' || apiOriginOf(apiUrl) !== apiUrl) {
    throw invalid('apiUrl must be an https origin (http only on a loopback host)');
  }
  if (!isRunnerId(runnerId)) {
    throw invalid('runnerId must be a runner id');
  }
  if (!isUlid(accountId)) {
    throw invalid('accountId must be an account id');
  }
  if (typeof name !== 'string' || name.length === 0 || name.length > 64) {
    throw invalid('name must be 1 to 64 characters');
  }
  if (typeof audience !== 'string' || !AUDIENCE.test(audience)) {
    throw invalid('audience must be team-console:<environment>');
  }
  if (
    !Array.isArray(allowedProjects) ||
    !allowedProjects.every((slug) => typeof slug === 'string' && isValidSlug(slug))
  ) {
    throw invalid('allowedProjects must be a list of project slugs');
  }
  if (
    typeof pollSeconds !== 'number' ||
    !Number.isInteger(pollSeconds) ||
    pollSeconds < 5 ||
    pollSeconds > 3600
  ) {
    throw invalid('pollSeconds must be an integer from 5 to 3600');
  }
  if (!isEnrolBackend(backend)) {
    throw invalid(`backend must be one of ${ENROL_BACKENDS.join(', ')}`);
  }
  return {
    schema: CONFIG_SCHEMA_VERSION,
    apiUrl,
    runnerId,
    accountId,
    name,
    audience,
    allowedProjects: allowedProjects as string[],
    pollSeconds,
    backend,
  };
}

/** Reads `config.json` after checking the home (not group/world-writable) and the file (0600, the runner's own). */
export async function loadRunnerConfig(home: string): Promise<RunnerConfig> {
  await assertPrivateDir(home);
  const text = await readPrivateFile(configPathOf(home));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalid('is not valid JSON');
  }
  return parseRunnerConfig(parsed);
}

/** Writes a new `config.json` 0600; an existing one is never overwritten (`file-exists`). */
export async function saveRunnerConfig(home: string, config: RunnerConfig): Promise<void> {
  await assertPrivateDir(home);
  await writePrivateFile(configPathOf(home), `${JSON.stringify(parseRunnerConfig(config), null, 2)}\n`);
}
