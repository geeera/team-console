import { parseArgs } from 'node:util';
import { RUNNER_BINARY, type RunnerHostDto } from '@shared/contracts';
import { BackendError, type IsolationBackend } from '../backends/backend';
import { NoneBackend } from '../backends/none';
import { RunnerApiError, RunnerClient, type FetchLike } from '../client/runner-client';
import { loadRunnerConfig, runnerHomeOf, type RunnerConfig } from '../config/config';
import { RunnerFileError } from '../config/private-files';
import { loadRunnerKey } from '../config/runner-key';
import { runLoop } from '../jobs/loop';
import { RUNNER_VERSION } from '../version';
import { EnrolUsageError, enrol } from './enrol';

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
}

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

const USAGE = [
  `Usage: ${RUNNER_BINARY} <command>`,
  '',
  'Commands:',
  '  enrol --url <console origin> --code <tce_…> --backend container|user|none',
  '        Enrol this host with the one-time code from Settings › Runners.',
  '  run-once  Claim one job, run it and exit (exit 0 also when there is none or the runner is paused).',
  '  run --loop  Claim and run jobs until Ctrl-C.',
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
      default:
        return error.message;
    }
  }
  if (error instanceof RunnerFileError || error instanceof EnrolUsageError || error instanceof BackendError) {
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

async function runEnrol(args: readonly string[], deps: CliDeps): Promise<number> {
  let values: { url?: string; code?: string; backend?: string };
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: { url: { type: 'string' }, code: { type: 'string' }, backend: { type: 'string' } },
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
  const { url, code, backend } = values;
  if (url === undefined || code === undefined || backend === undefined) {
    deps.stderr(`enrol needs --url, --code and --backend.\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  try {
    const home = runnerHomeOf(deps.env, deps.homeDir);
    const config = await enrol({ url, code, backend }, { home, fetch: deps.fetch, host: deps.host });
    const projects =
      config.allowedProjects.length === 0 ? 'no projects yet' : config.allowedProjects.join(', ');
    deps.stdout(
      `Enrolled "${config.name}" (${config.runnerId}) on ${config.apiUrl} with the ${config.backend} backend; projects: ${projects}.`,
    );
    deps.stdout(`Config and key are in ${home}.`);
    return EXIT_OK;
  } catch (error: unknown) {
    deps.stderr(`enrol failed: ${describeFailure(error)}`);
    return error instanceof EnrolUsageError ? EXIT_USAGE : EXIT_FAILED;
  }
}

function backendOf(config: RunnerConfig, home: string): IsolationBackend {
  if (config.backend === 'none') {
    return new NoneBackend(home);
  }
  throw new BackendError(`the ${config.backend} backend is not in this runner version yet (2-B-3)`);
}

async function runJobs(mode: 'once' | 'loop', deps: CliDeps): Promise<number> {
  try {
    const home = runnerHomeOf(deps.env, deps.homeDir);
    const config = await loadRunnerConfig(home);
    const client = new RunnerClient({
      apiUrl: config.apiUrl,
      runnerId: config.runnerId,
      audience: config.audience,
      privateKey: await loadRunnerKey(home),
      fetch: deps.fetch,
    });
    const end = await runLoop(mode, {
      home,
      config,
      client,
      backend: backendOf(config, home),
      sourceEnv: deps.env,
      log: deps.stdout,
      now: () => new Date(),
      shutdown: deps.shutdown ?? new AbortController().signal,
    });
    deps.stdout(end === 'idle' ? 'No job is queued for this runner.' : `Runner stopped (${end}).`);
    return EXIT_OK;
  } catch (error: unknown) {
    deps.stderr(`run failed: ${describeFailure(error)}`);
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
    case 'run-once':
      return rest.length === 0 ? runJobs('once', deps) : usageError(deps, 'run-once takes no arguments.');
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
