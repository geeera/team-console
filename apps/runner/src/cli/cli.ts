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
import { jobExecOf } from '../install/templates';
import { RunnerFileError } from '../config/private-files';
import { loadRunnerKey, runnerKeyLocationOf, type RunnerKeyDeps } from '../config/runner-key';
import { runLoop } from '../jobs/loop';
import { RUNNER_VERSION } from '../version';
import { autoUpdater } from '../update/auto-update';
import { UpdateError, applyUpdate, checkForUpdate, type ApplyDeps } from '../update/update';
import { EnrolUsageError, enrol } from './enrol';
import { ENROL_CODE_STDIN, enrolCodeOf, type ReadCodeLine } from './enrol-code';
import { REQUEST_TOKEN_STDIN, runOnceOidc } from './run-once-oidc';

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
  /** `lsof` for the `actions-ephemeral` sandbox sweep; the host's when absent. */
  readonly exec?: Exec;
  /** One line of stdin for `run-once --oidc --request-token -`; absent when the process has no stdin to read. */
  readonly readRequestTokenLine?: () => Promise<string>;
}

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

const USAGE = [
  `Usage: ${RUNNER_BINARY} <command>`,
  '',
  'Commands:',
  '  install --backend user|container (--dry-run | --yes) [--home <dir>] [--image <name@sha256:…>] [--runtime docker|podman|container]',
  '        List (--dry-run) or make (--yes) the job users, sudoers rule and service; user needs sudo, container must not.',
  '  enrol --url <console origin> --backend container|user|none [--code -]',
  '        [--credential api-key|setup-token|claude-config-dir] [--claude-config-dir <dir>] [--image <name@sha256:…>]',
  `        Enrol this host with the one-time code from Settings › Runners, read from ${ENROL_CODE_ENV} or, with`,
  '        --code -, from one line of stdin (prompted on a terminal). --code <tce_…> works too, but any local user',
  '        can read an argument with ps while enrol runs.',
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
    error instanceof BackendError ||
    error instanceof InstallError ||
    error instanceof UpdateError ||
    error instanceof ActionsRunError
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
  };
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        url: { type: 'string' },
        code: { type: 'string' },
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
    // Read only once the flags are complete, so a usage slip never swallows a piped code.
    const code = await enrolCodeOf(values.code, deps.env, deps.readCodeLine);
    if (code === undefined) {
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
        backend,
        credential: values.credential,
        claudeConfigDir: values['claude-config-dir'],
        image: values.image,
      },
      { home, fetch: deps.fetch, host: deps.host, ...(deps.keys === undefined ? {} : { keys: deps.keys }) },
    );
    const projects =
      config.allowedProjects.length === 0 ? 'no projects yet' : config.allowedProjects.join(', ');
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

const RUNTIME_ENV = ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'XDG_RUNTIME_DIR'];

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
        nodeDir: dirname(process.execPath),
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
        node: process.execPath,
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
    node: process.execPath,
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

export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
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
