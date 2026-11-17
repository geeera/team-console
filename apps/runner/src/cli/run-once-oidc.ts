import { isAbsolute, join } from 'node:path';
import { isUlid, type RunnerHostDto } from '@shared/contracts';
import { redactSecrets } from '@shared/redaction';
import { ActionsEphemeralBackend } from '../backends/actions-ephemeral';
import {
  ActionsRunError,
  idTokenRequestUrlOf,
  postOidcExchange,
  requestActionsIdToken,
} from '../client/actions-oidc';
import { RunnerClient, type FetchLike } from '../client/runner-client';
import { RUNNER_HOME_ENV, apiOriginOf } from '../config/config';
import { ensurePrivateDir, lstatOrNull } from '../config/private-files';
import { generateRunnerKey } from '../config/runner-key';
import { INFERENCE_API_KEY_ENV, jobCredentialOf } from '../env/credential';
import { RUNNER_GIT_ENV_ALLOWED } from '../git/git';
import type { Exec } from '../host/exec';
import { LaunchRefusal } from '../jobs/refusal';
import { runJob, type JobReport, type JobRunConfig } from '../jobs/run-job';
import { JobRegistry } from '../proxy/job-registry';
import { RUNNER_VERSION } from '../version';
import { hostFieldOf } from './enrol';

/**
 * `run-once --oidc` (#669; architect note on #573, ADR 0008 decision 7(a′)): the runner inside the customer's
 * `team-console-runner.yml` run on a GitHub-hosted VM. Everything comes from the env, nothing is persisted: no
 * `config.json`, no key file, no `state.json`. It generates an Ed25519 key in memory, asks GitHub for the run's OIDC
 * token with the console's runner audience, exchanges it for the one job the run was dispatched for, and runs that
 * job on the `actions-ephemeral` backend through the ordinary heartbeat/events/proxy/finish protocol. The console
 * revokes the identity at `finish`.
 *
 * The request token may come on stdin instead (`--request-token -`, #712): the workflow template passes it that way,
 * so this process, which supervises the job for the whole run, never has it in its environment (`/proc/<pid>/environ`
 * is readable by the job, which runs as the same uid on the VM). The token then lives in this process's memory only,
 * together with the job's console identity. Two controls keep the job out of that memory: the template's ptrace scope
 * 2 (no attach) and `--disable-sigusr1` (launcher and template `NODE_OPTIONS`), without which the job could open this
 * process's Node inspector with `kill -USR1` and evaluate code in it. A local privilege escalation still reaches it.
 *
 * Output: stdout carries the job id and nothing else; the CLI's stream goes to the job's events; the runner's own
 * lines go to stderr through the redactor. The inference key, the OIDC token, the request token and the read token
 * never reach either.
 */

/** The env names the run reads; the workflow template (#671) sets the `TC_*` ones, GitHub the rest. */
export const ACTIONS_RUN_ENV = {
  consoleUrl: 'TC_CONSOLE_URL',
  jobId: 'TC_JOB_ID',
  /** `team-console:<environment>` of the console; the OIDC token's `aud` and the exchanged runner JWTs' `aud`. */
  audience: 'TC_CONSOLE_AUDIENCE',
  /** Optional: the Claude Code CLI as an absolute path; else `claude` on the job's PATH. */
  claude: 'TC_CLAUDE_COMMAND',
  runnerTemp: 'RUNNER_TEMP',
  idTokenUrl: 'ACTIONS_ID_TOKEN_REQUEST_URL',
  idTokenToken: 'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  serverUrl: 'GITHUB_SERVER_URL',
  repository: 'GITHUB_REPOSITORY',
  /** Optional: `${{ github.token }}` (`contents: read`), the mirror fetch's read token. */
  readToken: 'GITHUB_TOKEN',
} as const;

/** `run-once --oidc --request-token -`: the request token is one line of stdin, never an env value or an argument. */
export const REQUEST_TOKEN_STDIN = '-';
/** A request token is a JWT of about a kilobyte; the same bound as an env value. */
export const REQUEST_TOKEN_MAX_BYTES = 8192;

/** The runner home inside the VM's per-job temp directory, which GitHub empties after the job. */
export const ACTIONS_HOME_DIR = 'tc';

const AUDIENCE = /^team-console:[a-z][a-z0-9-]{0,31}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const TOKEN_VALUE = /^[\x21-\x7e]{8,8192}$/;
const ABSOLUTE_COMMAND = /^\/[^\0]{1,1023}$/;
const JOB_PATH_TAIL = '/usr/local/bin:/usr/bin:/bin';

export interface ActionsRunSettings {
  readonly apiUrl: string;
  readonly jobId: string;
  readonly audience: string;
  readonly home: string;
  readonly idToken: { readonly url: URL; readonly token: string };
  /** `<server>/<owner>/<repo>.git` of the run's own repository, the one its OIDC token names. */
  readonly upstream: string;
  readonly readToken: string | null;
  readonly toolchain: { readonly path: string; readonly claude: string };
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The run's settings from `env`, or an `ActionsRunError` naming every variable that is missing or wrong (names only,
 * never a value). `nodeDir` is where the running node lives: the job's PATH starts there, so a CLI installed with
 * that node's `npm i -g` is found. `stdinRequestToken` is the line `--request-token -` read; with it, the variable
 * must be unset, so which of the two was used is never a guess.
 */
export function actionsRunSettingsOf(env: Env, nodeDir: string, stdinRequestToken?: string): ActionsRunSettings {
  const problems: string[] = [];
  const read = (name: string): string => {
    const value = env[name]?.trim() ?? '';
    if (value === '') {
      problems.push(`${name} is not set`);
    }
    return value;
  };
  const optional = (name: string): string | null => {
    const value = env[name]?.trim() ?? '';
    return value === '' ? null : value;
  };

  const consoleUrl = read(ACTIONS_RUN_ENV.consoleUrl);
  const apiUrl = consoleUrl === '' ? null : apiOriginOf(consoleUrl);
  if (consoleUrl !== '' && apiUrl === null) {
    problems.push(`${ACTIONS_RUN_ENV.consoleUrl} must be the console origin, https://…`);
  }
  const jobId = read(ACTIONS_RUN_ENV.jobId);
  if (jobId !== '' && !isUlid(jobId)) {
    problems.push(`${ACTIONS_RUN_ENV.jobId} must be a job id`);
  }
  const audience = read(ACTIONS_RUN_ENV.audience);
  if (audience !== '' && !AUDIENCE.test(audience)) {
    problems.push(`${ACTIONS_RUN_ENV.audience} must be team-console:<environment>`);
  }
  const runnerTemp = read(ACTIONS_RUN_ENV.runnerTemp);
  if (runnerTemp !== '' && !isAbsolute(runnerTemp)) {
    problems.push(`${ACTIONS_RUN_ENV.runnerTemp} must be an absolute path`);
  }
  const home = join(runnerTemp, ACTIONS_HOME_DIR);
  const configuredHome = optional(RUNNER_HOME_ENV);
  if (configuredHome !== null && runnerTemp !== '' && configuredHome !== home) {
    problems.push(`${RUNNER_HOME_ENV} must be unset or $${ACTIONS_RUN_ENV.runnerTemp}/${ACTIONS_HOME_DIR}`);
  }
  const idTokenUrl = read(ACTIONS_RUN_ENV.idTokenUrl);
  const idTokenRequestUrl = idTokenUrl === '' ? null : idTokenRequestUrlOf(idTokenUrl);
  if (idTokenUrl !== '' && idTokenRequestUrl === null) {
    problems.push(`${ACTIONS_RUN_ENV.idTokenUrl} must be an https URL`);
  }
  let idTokenToken: string;
  if (stdinRequestToken === undefined) {
    idTokenToken = read(ACTIONS_RUN_ENV.idTokenToken);
  } else {
    idTokenToken = stdinRequestToken.trim();
    if (optional(ACTIONS_RUN_ENV.idTokenToken) !== null) {
      problems.push(`give the request token once: --request-token - or ${ACTIONS_RUN_ENV.idTokenToken}, not both`);
    }
    if (!TOKEN_VALUE.test(idTokenToken)) {
      problems.push('--request-token - did not read one token from stdin');
    }
  }
  const serverUrl = read(ACTIONS_RUN_ENV.serverUrl);
  const server = serverUrl === '' ? null : apiOriginOf(serverUrl);
  if (serverUrl !== '' && server === null) {
    problems.push(`${ACTIONS_RUN_ENV.serverUrl} must be an https origin`);
  }
  const repository = read(ACTIONS_RUN_ENV.repository);
  if (repository !== '' && (!REPOSITORY.test(repository) || repository.split('/').some((part) => /^\.+$/.test(part)))) {
    problems.push(`${ACTIONS_RUN_ENV.repository} must be <owner>/<name>`);
  }
  const readToken = optional(ACTIONS_RUN_ENV.readToken);
  if (readToken !== null && !TOKEN_VALUE.test(readToken)) {
    problems.push(`${ACTIONS_RUN_ENV.readToken} does not hold one token`);
  }
  const claude = optional(ACTIONS_RUN_ENV.claude);
  if (claude !== null && !ABSOLUTE_COMMAND.test(claude)) {
    problems.push(`${ACTIONS_RUN_ENV.claude} must be an absolute path`);
  }
  if (problems.length > 0 || apiUrl === null || idTokenRequestUrl === null || server === null) {
    // No own prefix here: the caller (`runOidc` in cli.ts) already prefixes every refusal once.
    throw new ActionsRunError(`${problems.join('; ')}.`);
  }
  return {
    apiUrl,
    jobId,
    audience,
    home,
    idToken: { url: idTokenRequestUrl, token: idTokenToken },
    upstream: `${server}/${repository}.git`,
    readToken,
    toolchain: { path: `${nodeDir}:${JOB_PATH_TAIL}`, claude: claude ?? 'claude' },
  };
}

/** What the job loop may read of the runner's env: git's allow-list and the inference key, nothing else of the run's. */
function jobSourceEnvOf(env: Env): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of [...RUNNER_GIT_ENV_ALLOWED, INFERENCE_API_KEY_ENV]) {
    const value = env[name];
    if (value !== undefined) {
      picked[name] = value;
    }
  }
  return picked;
}

export interface OidcRunDeps {
  readonly env: Env;
  readonly fetch: FetchLike;
  readonly host: RunnerHostDto;
  /** The job id, once the exchange claimed it; the only line on stdout. */
  readonly stdout: (line: string) => void;
  /** The runner's own lines; every one passes the redactor first. */
  readonly stderr: (line: string) => void;
  readonly nodeDir: string;
  readonly now: () => Date;
  readonly shutdown: AbortSignal;
  /** `lsof` for the sandbox sweep; the host's when absent. */
  readonly exec?: Exec;
  readonly timing?: { readonly heartbeatMs?: number; readonly flushMs?: number; readonly minuteMs?: number };
  /** The request token `--request-token -` read from stdin; absent when it comes from the env. */
  readonly stdinRequestToken?: string;
}

export type OidcRunEnd = { readonly kind: 'ran'; readonly report: JobReport } | { readonly kind: 'shutdown' };

export async function runOnceOidc(deps: OidcRunDeps): Promise<OidcRunEnd> {
  const settings = actionsRunSettingsOf(deps.env, deps.nodeDir, deps.stdinRequestToken);
  const sourceEnv = jobSourceEnvOf(deps.env);
  const credential = { kind: 'api-key', env: INFERENCE_API_KEY_ENV } as const;
  try {
    // Before the exchange: a run without its key must not spend the job's one exchange.
    await jobCredentialOf(settings.home, credential, 'actions-ephemeral', sourceEnv);
  } catch (error: unknown) {
    if (error instanceof LaunchRefusal) {
      // `credential-not-allowed` names its own reason (#713, a subscription-shaped value); anything else here is
      // the env not holding a usable key at all, which reads better as one plain sentence.
      throw new ActionsRunError(
        error.reason === 'credential-not-allowed'
          ? `${error.message}.`
          : `${INFERENCE_API_KEY_ENV} is missing or not one key; set it as a secret of the team-console Environment.`,
      );
    }
    throw error;
  }
  if ((await lstatOrNull(settings.home)) !== null) {
    throw new ActionsRunError(
      `${settings.home} already exists; run-once --oidc runs one job in a fresh ${ACTIONS_RUN_ENV.runnerTemp}.`,
    );
  }
  await ensurePrivateDir(settings.home);
  const backend = new ActionsEphemeralBackend(settings.home, ...(deps.exec === undefined ? [] : [deps.exec]));
  await backend.preflight();
  if (deps.shutdown.aborted) {
    return { kind: 'shutdown' };
  }

  const key = generateRunnerKey();
  const idToken = await requestActionsIdToken({ ...settings.idToken, audience: settings.audience }, deps.fetch);
  const exchanged = await postOidcExchange(
    settings.apiUrl,
    {
      idToken,
      jobId: settings.jobId,
      publicKey: key.publicJwk,
      version: RUNNER_VERSION,
      host: {
        os: hostFieldOf(deps.host.os),
        arch: hostFieldOf(deps.host.arch),
        hostname: hostFieldOf(deps.host.hostname),
      },
    },
    deps.fetch,
  );
  const { job } = exchanged;
  deps.stdout(job.id);

  const log = (line: string): void => deps.stderr(redactSecrets(line, 'loose'));
  log(`claimed job ${job.id} (${job.kind}) as runner ${exchanged.runner.id}`);
  const config: JobRunConfig = {
    apiUrl: settings.apiUrl,
    // The console gave this identity exactly the job's project; the runner holds itself to the same.
    allowedProjects: [job.projectSlug],
    repositories: { [job.projectSlug]: settings.upstream },
    toolchain: settings.toolchain,
    backend: backend.kind,
    credential,
    ...(settings.readToken === null ? {} : { vcs: { readToken: settings.readToken } }),
  };
  const report = await runJob(job, exchanged.jobToken, {
    home: settings.home,
    config,
    client: new RunnerClient({
      apiUrl: settings.apiUrl,
      runnerId: exchanged.runner.id,
      audience: exchanged.runner.audience,
      privateKey: key.privateKey,
      fetch: deps.fetch,
    }),
    backend,
    registry: new JobRegistry(),
    sourceEnv,
    log,
    now: deps.now,
    shutdown: deps.shutdown,
    // One job per identity: a limit has no next claim to pause, so the streak starts and ends here.
    limitStreak: 0,
    ...deps.timing,
  }, exchanged.teamConfig);
  return { kind: 'ran', report };
}
