import { parseArgs } from 'node:util';
import { RUNNER_BINARY, type RunnerHostDto } from '@shared/contracts';
import { RunnerApiError, type FetchLike } from '../client/runner-client';
import { runnerHomeOf } from '../config/config';
import { RunnerFileError } from '../config/private-files';
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
  if (error instanceof RunnerFileError || error instanceof EnrolUsageError) {
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

export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'enrol':
      return runEnrol(rest, deps);
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
