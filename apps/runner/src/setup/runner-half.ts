import { RunnerApiError, RunnerClient, type FetchLike } from '../client/runner-client';
import { loadRunnerConfig, type RunnerConfig } from '../config/config';
import { RunnerFileError } from '../config/private-files';
import { loadRunnerKey, type RunnerKeyDeps } from '../config/runner-key';
import { RUNNER_VERSION } from '../version';
import type { RunnerHalfReport } from './self-check';

/**
 * `self-check --runner-half`, as `_tcrunner` (#634 PR 2, checks 1 and 2): loads the config and the key the way the
 * service does and asks `GET /runner/self` with a fresh JWT. The report names the credential's kind and file (local
 * only, for root's check) and never a value; the request carries the JWT and nothing else.
 */

export interface RunnerHalfDeps {
  readonly fetch: FetchLike;
  readonly keys?: RunnerKeyDeps;
}

const messageOf = (error: unknown): string => {
  if (error instanceof RunnerFileError || error instanceof RunnerApiError) {
    return error.message;
  }
  if (error instanceof TypeError) {
    return 'the console could not be reached';
  }
  throw error;
};

function configPart(config: RunnerConfig): NonNullable<RunnerHalfReport['config']> {
  const { credential, toolchain } = config;
  return {
    name: config.name,
    apiUrl: config.apiUrl,
    backend: config.backend,
    credential:
      credential === undefined
        ? null
        : { kind: credential.kind, file: 'file' in credential ? credential.file : null },
    toolchain: toolchain === undefined ? null : { path: toolchain.path, claude: toolchain.claude ?? null },
  };
}

export async function runnerHalfReport(home: string, deps: RunnerHalfDeps): Promise<RunnerHalfReport> {
  let config: RunnerConfig;
  try {
    config = await loadRunnerConfig(home);
  } catch (error: unknown) {
    return {
      version: RUNNER_VERSION,
      failure: { stage: 'config', message: messageOf(error) },
      config: null,
      self: null,
    };
  }
  const part = configPart(config);
  let client: RunnerClient;
  try {
    client = new RunnerClient({
      apiUrl: config.apiUrl,
      runnerId: config.runnerId,
      audience: config.audience,
      privateKey: await loadRunnerKey(home, deps.keys),
      fetch: deps.fetch,
    });
  } catch (error: unknown) {
    return {
      version: RUNNER_VERSION,
      failure: { stage: 'key', message: messageOf(error) },
      config: part,
      self: null,
    };
  }
  try {
    const self = await client.self();
    return {
      version: RUNNER_VERSION,
      failure: null,
      config: part,
      self: {
        belowMinimum: self.runner.belowMinimum,
        pausedUntil: self.runner.pausedUntil,
        projects: self.projects,
      },
    };
  } catch (error: unknown) {
    return {
      version: RUNNER_VERSION,
      failure: { stage: 'identity', message: messageOf(error) },
      config: part,
      self: null,
    };
  }
}
