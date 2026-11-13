import { isAbsolute, join } from 'node:path';
import { isRunnerId, isUlid, isValidSlug, type RunnerIsolation } from '@shared/contracts';
import { RunnerFileError, assertPrivateDir, readPrivateFile, writePrivateFile } from './private-files';
import { CREDENTIAL_BACKENDS, parseCredentialConfig, type CredentialConfig } from '../env/credential';
import { PINNED_MODEL, isJobRole, type RoleOverrides } from '../claude/roles';

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
  /** What jobs need, set by the operator after `enrol` (ADR 0008 decisions 4, 5, 7, 8); all optional. */
  readonly credential?: CredentialConfig;
  readonly toolchain?: RunnerToolchain;
  readonly env?: { readonly passthrough: readonly string[] };
  readonly roles?: RoleOverrides;
  /** The clone URL per project slug the mirror fetches from (https, or an absolute path for a local repository). */
  readonly repositories?: Readonly<Record<string, string>>;
  /** The `container` backend (ADR 0008 decision 12); `image` is required there and must be pinned by digest. */
  readonly container?: ContainerSettings;
}

export const CONTAINER_RUNTIMES = ['docker', 'podman', 'container'] as const;
export type ContainerRuntime = (typeof CONTAINER_RUNTIMES)[number];

export interface ContainerSettings {
  readonly image: string;
  readonly runtime?: ContainerRuntime;
  /** `--network`; default `bridge` (egress allow-listing is H-2's). */
  readonly network?: string;
  readonly pidsLimit?: number;
  readonly memoryMb?: number;
}

/** `<name>[:tag]@sha256:<64 hex>`: a tag alone can be moved, a digest cannot. */
export const PINNED_IMAGE = /^[a-z0-9][a-z0-9._/-]{0,199}(?::[A-Za-z0-9._-]{1,128})?@sha256:[0-9a-f]{64}$/;
const NETWORK = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export interface RunnerToolchain {
  /** The job's `PATH`, never the runner's own. */
  readonly path: string;
  /** The Claude Code CLI; an absolute path or a name looked up on `path`. Default `claude`. */
  readonly claude?: string;
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
  'credential',
  'toolchain',
  'env',
  'roles',
  'repositories',
  'container',
] as const;

const TOOLCHAIN_PATH = /^\/[^:\0]*(?::\/[^:\0]*)*$/;
const COMMAND = /^(?:\/[^\0]+|[A-Za-z0-9][A-Za-z0-9._-]*)$/;

/** An https URL without credentials, query or fragment, or an absolute local path. */
export function isRepositoryUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 512) {
    return false;
  }
  if (value.startsWith('/')) {
    return !value.split('/').includes('..');
  }
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    // Not a URL: refused like any other malformed value.
    return false;
  }
}

function parseJobSettings(value: Record<string, unknown>): Partial<RunnerConfig> {
  const settings: {
    credential?: CredentialConfig;
    toolchain?: RunnerToolchain;
    env?: { passthrough: string[] };
    roles?: RoleOverrides;
    repositories?: Record<string, string>;
    container?: ContainerSettings;
  } = {};
  if (value['credential'] !== undefined) {
    const credential = parseCredentialConfig(value['credential']);
    if (credential === null) {
      throw invalid(
        'credential must be {kind: api-key|setup-token, file: credentials/<name>} or {kind: claude-config-dir, path}',
      );
    }
    settings.credential = credential;
  }
  const toolchain = value['toolchain'];
  if (toolchain !== undefined) {
    if (
      !isRecord(toolchain) ||
      Object.keys(toolchain).some((key) => key !== 'path' && key !== 'claude') ||
      typeof toolchain['path'] !== 'string' ||
      !TOOLCHAIN_PATH.test(toolchain['path']) ||
      (toolchain['claude'] !== undefined &&
        (typeof toolchain['claude'] !== 'string' || !COMMAND.test(toolchain['claude'])))
    ) {
      throw invalid('toolchain must be {path: absolute directories joined by ":", claude?: command}');
    }
    settings.toolchain =
      typeof toolchain['claude'] === 'string'
        ? { path: toolchain['path'], claude: toolchain['claude'] }
        : { path: toolchain['path'] };
  }
  const env = value['env'];
  if (env !== undefined) {
    const passthrough = isRecord(env) ? env['passthrough'] : undefined;
    if (
      !isRecord(env) ||
      Object.keys(env).some((key) => key !== 'passthrough') ||
      !Array.isArray(passthrough) ||
      !passthrough.every((name) => typeof name === 'string')
    ) {
      throw invalid('env must be {passthrough: [variable names]}');
    }
    // The names are judged at every launch (env-builder.ts), so a refused one fails a job with its reason.
    settings.env = { passthrough: [...(passthrough as string[])] };
  }
  const roles = value['roles'];
  if (roles !== undefined) {
    if (
      !isRecord(roles) ||
      !Object.entries(roles).every(
        ([role, entry]) =>
          isJobRole(role) &&
          isRecord(entry) &&
          Object.keys(entry).join() === 'model' &&
          typeof entry['model'] === 'string' &&
          PINNED_MODEL.test(entry['model']),
      )
    ) {
      throw invalid('roles must map a known role to {model: a pinned model id}');
    }
    settings.roles = roles as RoleOverrides;
  }
  const repositories = value['repositories'];
  if (repositories !== undefined) {
    if (
      !isRecord(repositories) ||
      !Object.entries(repositories).every(([slug, url]) => isValidSlug(slug) && isRepositoryUrl(url))
    ) {
      throw invalid('repositories must map a project slug to an https URL or an absolute path');
    }
    settings.repositories = repositories as Record<string, string>;
  }
  if (value['container'] !== undefined) {
    settings.container = parseContainerSettings(value['container']);
  }
  return settings;
}

const isIntIn = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

function parseContainerSettings(value: unknown): ContainerSettings {
  const fail = (): never => {
    throw invalid(
      'container must be {image: <name>@sha256:<digest>, runtime?: docker|podman|container, network?, pidsLimit?: 16-65536, memoryMb?: 256-262144}',
    );
  };
  if (!isRecord(value)) {
    return fail();
  }
  const allowed = ['image', 'runtime', 'network', 'pidsLimit', 'memoryMb'];
  const { image, runtime, network, pidsLimit, memoryMb } = value;
  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    typeof image !== 'string' ||
    !PINNED_IMAGE.test(image) ||
    (runtime !== undefined && !(CONTAINER_RUNTIMES as readonly unknown[]).includes(runtime)) ||
    (network !== undefined &&
      (typeof network !== 'string' || !NETWORK.test(network) || network === 'host')) ||
    (pidsLimit !== undefined && !isIntIn(pidsLimit, 16, 65_536)) ||
    (memoryMb !== undefined && !isIntIn(memoryMb, 256, 262_144))
  ) {
    return fail();
  }
  return value as unknown as ContainerSettings;
}

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
  const settings = parseJobSettings(value);
  // RR11 (ADR 0008 decision 5): a pairing the backend may not use is refused here too, not only at launch.
  if (settings.credential !== undefined && !CREDENTIAL_BACKENDS[settings.credential.kind].includes(backend)) {
    throw invalid(`the ${settings.credential.kind} credential is not allowed on the ${backend} backend`);
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
    ...settings,
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
