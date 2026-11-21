import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { ENROL_CODE_ENV, RUNNER_BINARY, type RunnerHostDto } from '@shared/contracts';
import { BackendError, type IsolationBackend } from '../backends/backend';
import { ContainerBackend } from '../backends/container';
import { NoneBackend } from '../backends/none';
import { SYSTEM_MANAGED_SETTINGS_PATH, UserBackend } from '../backends/user';
import { ActionsRunError } from '../client/actions-oidc';
import { RunnerApiError, RunnerClient, type FetchLike } from '../client/runner-client';
import {
  CONTAINER_RUNTIMES,
  loadRunnerConfig,
  runnerHomeOf,
  updatePolicyOf,
  type ContainerRuntime,
  type RunnerConfig,
} from '../config/config';
import { SYSTEM_PATH, hostExec, type Exec } from '../host/exec';
import { InstallError, runInstall, systemInstallHost, type InstallHost } from '../install/install';
import { DOCUMENTED_DEFAULTS, jobExecOf, nodeOf } from '../install/templates';
import { RunnerFileError } from '../config/private-files';
import { loadRunnerKey, runnerKeyLocationOf, type RunnerKeyDeps } from '../config/runner-key';
import { runLoop } from '../jobs/loop';
import { RUNNER_VERSION } from '../version';
import { autoUpdater } from '../update/auto-update';
import { UpdateError, applyUpdate, checkForUpdate, type ApplyDeps } from '../update/update';
import { EnrolIntentError, EnrolUsageError, enrol } from './enrol';
import { ENROL_CODE_STDIN, enrolCodeOf, type ReadCodeLine } from './enrol-code';
import { REQUEST_TOKEN_STDIN, runOnceOidc } from './run-once-oidc';
import { tmpdir } from 'node:os';
import { updateRunnerConfig } from '../config/config';
import {
  CredentialSetupError,
  hostSpawnClaude,
  isSetUpCredentialKind,
  setUpCredential,
  type SpawnClaude,
} from '../setup/credential';
import { openRequestChannel, systemSetupHost, userOpener } from '../setup/host';
import { runnerHalfReport } from '../setup/runner-half';
import { selfCheck, type SetupHost } from '../setup/self-check';
import { enrolmentOf, runContainerSetup } from '../setup/container-setup';
import { SetupError, installedPrefixOf, isSetupStep, runSetup, type OpenRequestChannel, type SetupStep } from '../setup/setup';
import { ToolchainError } from '../setup/toolchain';

/** Everything the CLI reads from the process, passed in so the specs drive it without touching the real host. */
export interface CliDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
  readonly host: RunnerHostDto;
  readonly fetch: FetchLike;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  /** Aborted on Ctrl-C / SIGTERM: a running job is finished `failed` with `runner-shutdown`. */
  readonly shutdown?: AbortSignal;
  /** The directory of the running bundle (`bin/job-exec` sits next to it). */
  readonly prefix?: string;
  readonly platform?: string;
  readonly uid?: number;
  readonly gid?: number;
  /** The installer's host; the real one when absent. */
  readonly installHost?: InstallHost;
  /** Runs `gh`, `tar` and `node` for `update`; the real host when absent. */
  readonly updateExec?: Exec;
  readonly arch?: string;
  readonly now?: () => Date;
  /** One line of stdin for `enrol --code -`; absent when the process has no stdin to read. */
  readonly readCodeLine?: ReadCodeLine;
  /** Where the runner key lives (platform, `security` exec, env); the host's when absent. */
  readonly keys?: RunnerKeyDeps;
  /** Where the running node lives (`run-once --oidc` puts it first on the job's PATH); `process.execPath`'s when absent. */
  readonly nodeDir?: string;
  /** How node was started (`process.argv0`: launchd's `ProgramArguments[0]`, the launcher's path); the process's when absent. */
  readonly argv0?: string;
  /** The running node with every link resolved (`process.execPath`); the process's when absent. */
  readonly execPath?: string;
  /** `lsof` for the `actions-ephemeral` sandbox sweep; the host's when absent. */
  readonly exec?: Exec;
  /** One line of stdin for `run-once --oidc --request-token -`; absent when the process has no stdin to read. */
  readonly readRequestTokenLine?: () => Promise<string>;
  /** Waits between enrolment polls; real time when absent. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** `setup` and `self-check` as root; the real macOS host when absent. */
  readonly setupHost?: SetupHost;
  readonly openRequestChannel?: () => Promise<OpenRequestChannel>;
  readonly openForUser?: (url: string) => Promise<void>;
  /** How long `self-check` watches the service keep one pid; 20 s when absent. */
  readonly settleMs?: number;
  /** `setup-credential`: how `claude setup-token` starts, the terminal it writes to and the hidden prompt of `api-key`. */
  readonly spawnClaude?: SpawnClaude;
  readonly terminal?: { readonly stdout: (text: string) => void; readonly stderr: (text: string) => void };
  readonly readHiddenLine?: (prompt: string) => Promise<string>;
  readonly tmpRoot?: string;
}

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

const USAGE = [
  `Usage: ${RUNNER_BINARY} <command>`,
  '',
  'Commands:',
  '  setup [--url <console origin> --enrolment <request id>] [--only install,enrol,toolchain,credential,service,check]',
  '        [--release <tarball> --sha256 <hex>] [--credential setup-token|api-key] [--replace-credential] [--from-pkg]',
  '        macOS, with sudo: the whole user backend in one go. Installs (from --release after checking its sum), enrols',
  '        with the request from Settings › Runners › Add runner (compare the fingerprint, approve there), finds claude,',
  '        git and node for jobs, captures the Claude sign-in as _tcrunner without showing it, starts the service and',
  '        runs self-check. --only re-runs some steps; each is safe to repeat.',
  '  setup --url <console origin> --image <name@sha256:…> [--replace-credential]',
  '        Linux, in the runner image as tcrunner (the console\'s Linux command): enrols TC_RUNNER_HOME for the container',
  '        backend with the request id in TC_ENROLMENT, asks for the Anthropic API key without showing it, and checks',
  '        that the console accepts the runner.',
  '  self-check  (with sudo) Check config, key, console, service, credential, toolchain and isolation; one line each.',
  '  install --backend user|container (--dry-run | --yes) [--home <dir>] [--image <name@sha256:…>] [--runtime docker|podman|container]',
  '        List (--dry-run) or make (--yes) the job users, sudoers rule and service; user needs sudo, container must not.',
  '  enrol --url <console origin> --backend container|user|none [--code -] [--enrolment <request id>]',
  '        [--credential api-key|setup-token|claude-config-dir] [--claude-config-dir <dir>] [--image <name@sha256:…>]',
  `        Enrol this host with the one-time code from Settings › Runners, read from ${ENROL_CODE_ENV} or, with`,
  '        --code -, from one line of stdin (prompted on a terminal). --code <tce_…> works too, but any local user',
  '        can read an argument with ps while enrol runs. --enrolment <request id> (Add runner) needs no code: the',
  '        console shows the fingerprint printed here, and the owner approves there.',
  '  run-once  Claim one job, run it and exit (exit 0 also when there is none or the runner is paused).',
  '  run-once --oidc [--request-token -]  Inside a GitHub Actions run: exchange the run\'s OIDC token for the job in',
  '        TC_JOB_ID, run it and exit. Reads only its env (TC_CONSOLE_URL, TC_JOB_ID, TC_CONSOLE_AUDIENCE,',
  '        TC_INFERENCE_API_KEY and GitHub\'s) and, with --request-token -, ACTIONS_ID_TOKEN_REQUEST_TOKEN as one line',
  '        of stdin instead of the env; keeps nothing; prints only the job id.',
  '  run --loop  Claim and run jobs until Ctrl-C.',
  '  update [--check]  Install the release the console names after `gh attestation verify` accepts it',
  '        (never a lower version); --check only says whether one is available.',
  '  version   Print this runner’s version.',
  '',
  'TC_RUNNER_HOME sets where the runner keeps its config and key (default ~/.team-console-runner).',
].join('\n');

/** A failure as the operator reads it: what went wrong and what to do, never a token, code or response body. */
function describeFailure(error: unknown): string {
  if (error instanceof RunnerApiError) {
    switch (error.problem) {
      case 'enrolment-code-invalid':
        return 'The console refused the code: it is wrong, already used or expired. Create a new one on Settings › Runners.';
      case 'runner-isolation-none':
        return 'This console does not accept a runner without isolation; choose --backend container or user.';
      case 'rate-limited':
        return 'Too many enrolment attempts; wait a minute and try again.';
      case 'oidc-exchange-refused':
        return `The console refused this run's OIDC exchange: ${error.message}. Check the workflow file, branch, Environment and job id.`;
      default:
        return error.message;
    }
  }
  if (
    error instanceof RunnerFileError ||
    error instanceof EnrolUsageError ||
    error instanceof EnrolIntentError ||
    error instanceof BackendError ||
    error instanceof InstallError ||
    error instanceof UpdateError ||
    error instanceof ActionsRunError ||
    error instanceof SetupError ||
    error instanceof CredentialSetupError ||
    error instanceof ToolchainError
  ) {
    return error.message;
  }
  if (error instanceof Error && error.name === 'TimeoutError') {
    return 'The console did not answer in time.';
  }
  if (error instanceof TypeError) {
    // fetch's network failure; its cause names the host, which the operator already knows.
    return 'The console could not be reached; check --url and the network.';
  }
  throw error;
}

/**
 * Where `enrol` just put the key, as the tail of the confirmation line. Enrol already succeeded by the time this
 * runs, so a lookup failure (an unreadable keychain between the write and this read, say) must not turn it into a
 * reported failure. It must not guess either: the key may be a keychain item, so a failed lookup says the location is
 * unknown and why, instead of naming `home`.
 */
async function keyLocationOf(home: string, keys: RunnerKeyDeps | undefined): Promise<string> {
  try {
    const location = await runnerKeyLocationOf(home, keys);
    return location === null ? 'not found where the runner looks for it' : `in ${location}`;
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    return `in a location that could not be determined (${reason})`;
  }
}

async function runEnrol(args: readonly string[], deps: CliDeps): Promise<number> {
  let values: {
    url?: string;
    code?: string;
    backend?: string;
    credential?: string;
    'claude-config-dir'?: string;
    image?: string;
    enrolment?: string;
  };
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        url: { type: 'string' },
        code: { type: 'string' },
        enrolment: { type: 'string' },
        backend: { type: 'string' },
        credential: { type: 'string' },
        'claude-config-dir': { type: 'string' },
        image: { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error: unknown) {
    if (error instanceof TypeError) {
      deps.stderr(`${error.message}\n\n${USAGE}`);
      return EXIT_USAGE;
    }
    throw error;
  }
  const { url, backend } = values;
  const missing = `enrol needs --url, --backend and the code (${ENROL_CODE_ENV} or --code -).\n\n${USAGE}`;
  if (url === undefined || backend === undefined) {
    deps.stderr(missing);
    return EXIT_USAGE;
  }
  try {
    // Read only once the flags are complete, so a usage slip never swallows a piped code. The intent door has none.
    const code =
      values.enrolment === undefined ? await enrolCodeOf(values.code, deps.env, deps.readCodeLine) : values.code;
    if (code === undefined && values.enrolment === undefined) {
      deps.stderr(missing);
      return EXIT_USAGE;
    }
    if (values.code !== undefined && values.code !== ENROL_CODE_STDIN) {
      deps.stderr(
        `warning: --code <value> puts the code in this command's arguments, which any local user can read with ps; use ${ENROL_CODE_ENV} or --code - instead.`,
      );
    }
    const home = runnerHomeOf(deps.env, deps.homeDir);
    const config = await enrol(
      {
        url,
        code,
        enrolment: values.enrolment,
        backend,
        credential: values.credential,
        claudeConfigDir: values['claude-config-dir'],
        image: values.image,
      },
      {
        home,
        fetch: deps.fetch,
        host: deps.host,
        out: deps.stdout,
        ...(deps.keys === undefined ? {} : { keys: deps.keys }),
        ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
        ...(deps.now === undefined ? {} : { now: deps.now }),
      },
    );
    const projects =
      config.projectScope === 'all'
        ? 'all projects of the account, present and future'
        : config.allowedProjects.length === 0
          ? 'no projects yet'
          : config.allowedProjects.join(', ');
    deps.stdout(
      `Enrolled "${config.name}" (${config.runnerId}) on ${config.apiUrl} with the ${config.backend} backend; projects: ${projects}.`,
    );
    // The key may be a keychain item, not a file under `home` (#585); say where it actually is. Enrol already
    // succeeded, so a lookup failure here is cosmetic only — it must not turn into "enrol failed".
    deps.stdout(`Config is in ${home}; the key is ${await keyLocationOf(home, deps.keys)}.`);
    return EXIT_OK;
  } catch (error: unknown) {
    deps.stderr(`enrol failed: ${describeFailure(error)}`);
    return error instanceof EnrolUsageError ? EXIT_USAGE : EXIT_FAILED;
  }
}

/**
 * #772: node as it was started, not its realpath, which for Homebrew is a versioned Cellar path that `brew upgrade`
 * removes. A bare `node` (started through PATH) says nothing about where it is, so the resolved path is the fallback.
 */
function launchedNodeOf(deps: CliDeps): string {
  const given = deps.argv0 ?? process.argv0;
  return given.startsWith('/') ? given : (deps.execPath ?? process.execPath);
}

// CONTAINER_HOST: rootless podman's socket of the Linux one command (#634 PR 7), which puts its client in remote mode.
const RUNTIME_ENV = ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'XDG_RUNTIME_DIR', 'CONTAINER_HOST'];

function pick(env: CliDeps['env'], names: readonly string[]): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of names) {
    const value = env[name];
    if (value !== undefined) {
      picked[name] = value;
    }
  }
  return picked;
}

function backendOf(config: RunnerConfig, home: string, deps: CliDeps): IsolationBackend {
  switch (config.backend) {
    case 'none':
      return new NoneBackend(home);
    case 'user': {
      const platform = deps.platform ?? process.platform;
      if (platform !== 'darwin' && platform !== 'linux') {
        throw new BackendError(`the user backend does not run on ${platform}`);
      }
      return new UserBackend({
        home,
        jobExec: jobExecOf(deps.prefix ?? dirname(process.argv[1] ?? '')),
        nodeDir: dirname(launchedNodeOf(deps)),
        managedSettingsPath: SYSTEM_MANAGED_SETTINGS_PATH[platform],
      });
    }
    case 'container':
      return new ContainerBackend({
        home,
        settings: config.container,
        credential: config.credential,
        runtimeEnv: pick(deps.env, RUNTIME_ENV),
        uid: deps.uid ?? process.getuid?.() ?? 0,
        gid: deps.gid ?? process.getgid?.() ?? 0,
      });
  }
}

async function runInstallCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  let values: {
    backend?: string;
    home?: string;
    image?: string;
    runtime?: string;
    'dry-run'?: boolean;
    yes?: boolean;
  };
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        backend: { type: 'string' },
        home: { type: 'string' },
        image: { type: 'string' },
        runtime: { type: 'string' },
        'dry-run': { type: 'boolean' },
        yes: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error: unknown) {
    if (error instanceof TypeError) {
      return usageError(deps, error.message);
    }
    throw error;
  }
  const { backend, runtime } = values;
  if ((backend !== 'user' && backend !== 'container') || values['dry-run'] === values.yes) {
    return usageError(deps, 'install needs --backend user|container and exactly one of --dry-run or --yes.');
  }
  if (runtime !== undefined && !(CONTAINER_RUNTIMES as readonly string[]).includes(runtime)) {
    return usageError(deps, '--runtime must be docker, podman or container.');
  }
  const exec: Exec = async (command, execArgs, options) =>
    await hostExec(command, execArgs, {
      ...options,
      env: { PATH: deps.env['PATH'] ?? SYSTEM_PATH, ...options?.env },
    });
  const host =
    deps.installHost ??
    systemInstallHost({
      platform: deps.platform ?? process.platform,
      uid: deps.uid ?? process.getuid?.() ?? -1,
      homeDir: deps.homeDir,
      exec,
    });
  try {
    await runInstall(
      {
        backend,
        apply: values.yes === true,
        prefix: deps.prefix ?? dirname(process.argv[1] ?? ''),
        node: launchedNodeOf(deps),
        home: values.home,
        image: values.image,
        runtime: runtime as ContainerRuntime | undefined,
      },
      host,
      deps.stdout,
    );
    return EXIT_OK;
  } catch (error: unknown) {
    deps.stderr(`install failed: ${describeFailure(error)}`);
    return EXIT_FAILED;
  }
}

/** What `gh` may see of the runner's environment: where it lives and its own auth, nothing else (no `GH_HOST`). */
const GH_ENV = ['PATH', 'HOME', 'GH_CONFIG_DIR', 'XDG_CONFIG_HOME', 'GH_TOKEN', 'GITHUB_TOKEN'];

function applyDepsOf(home: string, deps: CliDeps): ApplyDeps {
  return {
    home,
    prefix: deps.prefix ?? dirname(process.argv[1] ?? ''),
    platform: deps.platform ?? process.platform,
    arch: deps.arch ?? process.arch,
    exec: deps.updateExec ?? hostExec,
    ghEnv: { PATH: SYSTEM_PATH, ...pick(deps.env, GH_ENV) },
    uid: deps.uid ?? process.getuid?.() ?? null,
    log: deps.stdout,
  };
}

async function clientOf(home: string, config: RunnerConfig, deps: CliDeps): Promise<RunnerClient> {
  return new RunnerClient({
    apiUrl: config.apiUrl,
    runnerId: config.runnerId,
    audience: config.audience,
    privateKey: await loadRunnerKey(home),
    fetch: deps.fetch,
  });
}

async function runUpdate(args: readonly string[], deps: CliDeps): Promise<number> {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
    return usageError(deps, 'update takes only --check.');
  }
  try {
    const home = runnerHomeOf(deps.env, deps.homeDir);
    const config = await loadRunnerConfig(home);
    const client = await clientOf(home, config, deps);
    const check = await checkForUpdate({
      currentVersion: RUNNER_VERSION,
      policy: updatePolicyOf(config),
      release: () => client.release(),
    });
    switch (check.kind) {
      case 'no-release':
        deps.stdout(`The console names no runner release; ${check.current} stays.`);
        return EXIT_OK;
      case 'current':
        deps.stdout(`Up to date: ${check.current}.`);
        return EXIT_OK;
      case 'available':
        if (args[0] === '--check') {
          deps.stdout(`${check.target} is available (installed ${check.current}); run update to install it.`);
          return EXIT_OK;
        }
        await applyUpdate(check.target, applyDepsOf(home, deps));
        deps.stdout(
          `Updated ${check.current} → ${check.target}. Restart the runner's service to run it (docs/runbooks/runner.md › Update).`,
        );
        return EXIT_OK;
    }
  } catch (error: unknown) {
    deps.stderr(`update refused: ${describeFailure(error)}`);
    return EXIT_FAILED;
  }
}

async function runJobs(mode: 'once' | 'loop', deps: CliDeps): Promise<number> {
  if (mode === 'loop') {
    // #772: a node path that stopped existing shows up in logs/runner.log, not as a silent KeepAlive restart loop.
    const launched = launchedNodeOf(deps);
    const resolved = deps.execPath ?? process.execPath;
    deps.stdout(
      `team-console-runner ${RUNNER_VERSION} starting with node ${launched}${launched === resolved ? '' : ` (${resolved})`}`,
    );
  }
  try {
    const home = runnerHomeOf(deps.env, deps.homeDir);
    const config = await loadRunnerConfig(home);
    const client = await clientOf(home, config, deps);
    const now = deps.now ?? (() => new Date());
    const end = await runLoop(mode, {
      home,
      config,
      client,
      backend: backendOf(config, home, deps),
      sourceEnv: deps.env,
      log: deps.stdout,
      now,
      shutdown: deps.shutdown ?? new AbortController().signal,
      beforeClaim: autoUpdater({
        policy: updatePolicyOf(config),
        check: { currentVersion: RUNNER_VERSION, release: () => client.release() },
        apply: applyDepsOf(home, deps),
        now,
        log: deps.stdout,
      }),
    });
    deps.stdout(end === 'idle' ? 'No job is queued for this runner.' : `Runner stopped (${end}).`);
    return EXIT_OK;
  } catch (error: unknown) {
    deps.stderr(`run failed: ${describeFailure(error)}`);
    return EXIT_FAILED;
  }
}

/** `run-once --oidc`: exit 0 once the job ran (its result is the console's), non-zero on every refusal before it. */
async function runOidc(deps: CliDeps, requestTokenOnStdin: boolean): Promise<number> {
  try {
    let stdinRequestToken: string | undefined;
    if (requestTokenOnStdin) {
      if (deps.readRequestTokenLine === undefined) {
        throw new EnrolUsageError('--request-token - needs stdin, which this runner cannot read');
      }
      stdinRequestToken = await deps.readRequestTokenLine();
    }
    const end = await runOnceOidc({
      env: deps.env,
      fetch: deps.fetch,
      host: deps.host,
      stdout: deps.stdout,
      stderr: deps.stderr,
      nodeDir: deps.nodeDir ?? dirname(process.execPath),
      now: deps.now ?? (() => new Date()),
      shutdown: deps.shutdown ?? new AbortController().signal,
      ...(deps.exec === undefined ? {} : { exec: deps.exec }),
      ...(stdinRequestToken === undefined ? {} : { stdinRequestToken }),
    });
    if (end.kind === 'shutdown') {
      deps.stderr('Stopped before the exchange; the job stays queued for the console to settle.');
      return EXIT_FAILED;
    }
    return EXIT_OK;
  } catch (error: unknown) {
    deps.stderr(`run-once --oidc refused: ${describeFailure(error)}`);
    return EXIT_FAILED;
  }
}

function usageError(deps: CliDeps, message: string): number {
  deps.stderr(`${message}\n\n${USAGE}`);
  return EXIT_USAGE;
}

function parsed<T extends Record<string, string | boolean | undefined>>(
  args: readonly string[],
  options: Record<keyof T & string, { type: 'string' | 'boolean' }>,
): T | string {
  try {
    // parseArgs types its values from a literal options object; the callers name the same keys in T.
    const { values } = parseArgs({ args: [...args], options, strict: true, allowPositionals: false });
    return values as unknown as T;
  } catch (error: unknown) {
    if (error instanceof TypeError) {
      return error.message;
    }
    throw error;
  }
}

/** `setup` in the runner's container on Linux (#634 PR 7): enrol by `TC_ENROLMENT`, the API key, the console check. */
async function runLinuxSetup(
  values: {
    url?: string;
    enrolment?: string;
    only?: string;
    release?: string;
    sha256?: string;
    credential?: string;
    'replace-credential'?: boolean;
    'from-pkg'?: boolean;
    image?: string;
  },
  deps: CliDeps,
): Promise<number> {
  if (values.only !== undefined || values.release !== undefined || values.sha256 !== undefined || values['from-pkg'] === true) {
    return usageError(deps, 'On Linux, setup takes --url, --image and --replace-credential only (the request id comes in TC_ENROLMENT).');
  }
  if (values.credential !== undefined && values.credential !== 'api-key') {
    return usageError(deps, 'The container backend runs on an Anthropic API key: --credential api-key, or leave it out.');
  }
  try {
    const home = runnerHomeOf(deps.env, deps.homeDir);
    const keys = deps.keys === undefined ? {} : { keys: deps.keys };
    const ready = await runContainerSetup(
      {
        url: values.url,
        enrolment: enrolmentOf(values.enrolment, deps.env),
        image: values.image,
        replaceCredential: values['replace-credential'] === true,
      },
      {
        home,
        uid: deps.uid ?? process.getuid?.() ?? -1,
        out: deps.stdout,
        enrol: async (options) =>
          await enrol(options, {
            home,
            fetch: deps.fetch,
            host: deps.host,
            out: deps.stdout,
            ...keys,
            ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
            ...(deps.now === undefined ? {} : { now: deps.now }),
          }),
        setUpApiKey: async (config, replace) => {
          await setUpCredential(
            {
              home,
              config,
              terminal: deps.terminal ?? { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) },
              log: deps.stdout,
              tmpRoot: deps.tmpRoot ?? tmpdir(),
              spawnClaude: deps.spawnClaude ?? hostSpawnClaude,
              ...(deps.readHiddenLine === undefined ? {} : { readHiddenLine: deps.readHiddenLine }),
            },
            { kind: 'api-key', replace, claude: 'claude', path: SYSTEM_PATH },
          );
        },
        runnerHalf: async () => await runnerHalfReport(home, { fetch: deps.fetch, ...keys }),
      },
    );
    return ready ? EXIT_OK : EXIT_FAILED;
  } catch (error: unknown) {
    deps.stderr(`setup stopped: ${describeFailure(error)}`);
    return error instanceof EnrolUsageError ? EXIT_USAGE : EXIT_FAILED;
  }
}

async function runSetupCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  const values = parsed<{
    url?: string;
    enrolment?: string;
    only?: string;
    release?: string;
    sha256?: string;
    credential?: string;
    'replace-credential'?: boolean;
    'from-pkg'?: boolean;
    image?: string;
  }>(args, {
    url: { type: 'string' },
    enrolment: { type: 'string' },
    only: { type: 'string' },
    release: { type: 'string' },
    sha256: { type: 'string' },
    credential: { type: 'string' },
    'replace-credential': { type: 'boolean' },
    'from-pkg': { type: 'boolean' },
    image: { type: 'string' },
  });
  if (typeof values === 'string') {
    return usageError(deps, values);
  }
  if ((deps.platform ?? process.platform) === 'linux') {
    return await runLinuxSetup(values, deps);
  }
  if (values.image !== undefined) {
    return usageError(deps, '--image is for the Linux setup in the runner’s container.');
  }
  const only = values.only?.split(',').map((step) => step.trim());
  if (only !== undefined && (only.length === 0 || !only.every(isSetupStep))) {
    return usageError(deps, '--only takes steps from install,enrol,toolchain,credential,service,check, comma-separated.');
  }
  if ((values.release === undefined) !== (values.sha256 === undefined)) {
    return usageError(deps, '--release and --sha256 go together.');
  }
  const credential = values.credential ?? 'setup-token';
  if (!isSetUpCredentialKind(credential)) {
    return usageError(deps, '--credential must be setup-token or api-key.');
  }
  const options = {
    url: values.url,
    enrolment: values.enrolment,
    only: only as SetupStep[] | undefined,
    fromPkg: values['from-pkg'] === true,
    release:
      values.release === undefined || values.sha256 === undefined
        ? undefined
        : { tarball: values.release, sha256: values.sha256 },
    credential,
    replaceCredential: values['replace-credential'] === true,
    prefix: deps.prefix ?? dirname(process.argv[1] ?? ''),
    node: launchedNodeOf(deps),
  };
  const tmpRoot = deps.tmpRoot ?? tmpdir();
  try {
    const host = deps.setupHost ?? systemSetupHostOf(deps, installedPrefixOf(options));
    const ready = await runSetup(options, {
      host,
      out: deps.stdout,
      tmpRoot,
      openRequestChannel: deps.openRequestChannel ?? (() => openRequestChannel(tmpRoot)),
      openForUser: deps.openForUser ?? userOpener(deps.env),
      ...(deps.settleMs === undefined ? {} : { settleMs: deps.settleMs }),
    });
    return ready ? EXIT_OK : EXIT_FAILED;
  } catch (error: unknown) {
    deps.stderr(`setup stopped: ${describeFailure(error)}`);
    return EXIT_FAILED;
  }
}

function systemSetupHostOf(deps: CliDeps, prefix: string): SetupHost {
  return systemSetupHost({
    uid: deps.uid ?? process.getuid?.() ?? -1,
    homeDir: deps.homeDir,
    prefix,
    // `_tcrunner` cannot traverse where root unpacked the one-liner's copy; the installed root-owned node it can.
    node: nodeOf(prefix),
    env: deps.env,
  });
}

async function runSelfCheck(args: readonly string[], deps: CliDeps): Promise<number> {
  if (args.length === 1 && args[0] === '--runner-half') {
    // The runner's half, as `_tcrunner`: one JSON line for root's check, no secret in it.
    const home = runnerHomeOf(deps.env, deps.homeDir);
    const report = await runnerHalfReport(home, { fetch: deps.fetch, ...(deps.keys === undefined ? {} : { keys: deps.keys }) });
    deps.stdout(JSON.stringify(report));
    return EXIT_OK;
  }
  if (args.length > 0) {
    return usageError(deps, 'self-check takes no arguments.');
  }
  if ((deps.platform ?? process.platform) !== 'darwin' || (deps.uid ?? process.getuid?.() ?? -1) !== 0) {
    deps.stderr('self-check checks the user backend on macOS and runs with sudo.');
    return EXIT_USAGE;
  }
  const prefix = deps.prefix ?? dirname(process.argv[1] ?? '');
  try {
    const ready = await selfCheck(deps.setupHost ?? systemSetupHostOf(deps, prefix), {
      home: DOCUMENTED_DEFAULTS.home,
      prefix,
      out: deps.stdout,
      settleMs: deps.settleMs ?? 20_000,
    });
    return ready ? EXIT_OK : EXIT_FAILED;
  } catch (error: unknown) {
    deps.stderr(`self-check failed: ${describeFailure(error)}`);
    return EXIT_FAILED;
  }
}

/** `setup-credential`, as `_tcrunner` (started by `setup`): the Claude sign-in captured, never shown. */
async function runSetupCredential(args: readonly string[], deps: CliDeps): Promise<number> {
  const values = parsed<{ kind?: string; replace?: boolean; 'open-requests'?: string }>(args, {
    kind: { type: 'string' },
    replace: { type: 'boolean' },
    'open-requests': { type: 'string' },
  });
  if (typeof values === 'string') {
    return usageError(deps, values);
  }
  if (!isSetUpCredentialKind(values.kind)) {
    return usageError(deps, 'setup-credential needs --kind setup-token|api-key.');
  }
  const openRequests = values['open-requests'];
  if (openRequests !== undefined && !openRequests.startsWith('/')) {
    return usageError(deps, '--open-requests must be an absolute path.');
  }
  try {
    const home = runnerHomeOf(deps.env, deps.homeDir);
    const config = await loadRunnerConfig(home);
    const claude = config.toolchain?.claude;
    if (values.kind === 'setup-token' && (claude === undefined || !claude.startsWith('/'))) {
      throw new CredentialSetupError('config.json names no claude for jobs yet: run setup --only toolchain first');
    }
    await setUpCredential(
      {
        home,
        config,
        terminal: deps.terminal ?? { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) },
        log: deps.stdout,
        tmpRoot: deps.tmpRoot ?? tmpdir(),
        spawnClaude: deps.spawnClaude ?? hostSpawnClaude,
        ...(deps.readHiddenLine === undefined ? {} : { readHiddenLine: deps.readHiddenLine }),
        ...(openRequests === undefined ? {} : { openRequests }),
        ...(deps.env['TERM'] === undefined ? {} : { term: deps.env['TERM'] }),
      },
      {
        kind: values.kind,
        replace: values.replace === true,
        claude: claude ?? 'claude',
        path: config.toolchain?.path ?? SYSTEM_PATH,
      },
    );
    return EXIT_OK;
  } catch (error: unknown) {
    deps.stderr(`credential: ${describeFailure(error)}`);
    return EXIT_FAILED;
  }
}

/** `setup-toolchain --path <dirs> --claude <path>`, as `_tcrunner`: what root's probe found, into config.json. */
async function runSetupToolchain(args: readonly string[], deps: CliDeps): Promise<number> {
  const values = parsed<{ path?: string; claude?: string }>(args, { path: { type: 'string' }, claude: { type: 'string' } });
  if (typeof values === 'string' || values.path === undefined || values.claude === undefined) {
    return usageError(deps, typeof values === 'string' ? values : 'setup-toolchain needs --path and --claude.');
  }
  const toolchain = { path: values.path, claude: values.claude };
  try {
    await updateRunnerConfig(runnerHomeOf(deps.env, deps.homeDir), (config) => ({ ...config, toolchain }));
    return EXIT_OK;
  } catch (error: unknown) {
    deps.stderr(`toolchain: ${describeFailure(error)}`);
    return EXIT_FAILED;
  }
}

export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'setup':
      return runSetupCommand(rest, deps);
    case 'self-check':
      return runSelfCheck(rest, deps);
    case 'setup-credential':
      return runSetupCredential(rest, deps);
    case 'setup-toolchain':
      return runSetupToolchain(rest, deps);
    case 'enrol':
      return runEnrol(rest, deps);
    case 'install':
      return runInstallCommand(rest, deps);
    case 'run-once':
      if (rest.length === 1 && rest[0] === '--oidc') {
        return runOidc(deps, false);
      }
      if (rest.length === 3 && rest[0] === '--oidc' && rest[1] === '--request-token' && rest[2] === REQUEST_TOKEN_STDIN) {
        return runOidc(deps, true);
      }
      return rest.length === 0
        ? runJobs('once', deps)
        : usageError(deps, 'run-once takes only --oidc [--request-token -].');
    case 'update':
      return runUpdate(rest, deps);
    case 'run':
      return rest.length === 1 && rest[0] === '--loop'
        ? runJobs('loop', deps)
        : usageError(deps, 'run needs --loop (or use run-once).');
    case 'version':
    case '--version':
      deps.stdout(RUNNER_VERSION);
      return EXIT_OK;
    case undefined:
    case 'help':
    case '--help':
      deps.stdout(USAGE);
      return command === undefined ? EXIT_USAGE : EXIT_OK;
    default:
      deps.stderr(`Unknown command "${command}".\n\n${USAGE}`);
      return EXIT_USAGE;
  }
}
