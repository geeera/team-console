import { spawn } from 'node:child_process';

/**
 * `git` as the runner runs it: no shell, an allow-listed env without any `GIT_*` of the runner's process (`GIT_CONFIG_*`
 * would inject config the refusal table never sees), no prompt. Its stderr is never copied into an error: a URL or
 * a credential helper's output could be in it.
 */

const GIT_OUTPUT_MAX_BYTES = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 10 * 60 * 1000;

export class GitError extends Error {
  constructor(
    readonly subcommand: string,
    readonly exitCode: number | null,
  ) {
    super(`git ${subcommand} failed (exit ${String(exitCode)})`);
    this.name = 'GitError';
  }
}

/**
 * What the mirror fetch may need from the runner's process: HOME and PATH, an ssh agent for an ssh upstream, and
 * the proxy and TLS variables curl reads. Anything else (an inference key, a token in the runner's env) stays out of
 * git and of whatever git spawns.
 */
export const RUNNER_GIT_ENV_ALLOWED: readonly string[] = [
  'HOME',
  'PATH',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'SSH_AUTH_SOCK',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'CURL_CA_BUNDLE',
];

/** The runner's env for git: an allow-list of its own variables (the mirror fetch uses its read access), no `GIT_*`. */
export function runnerGitEnv(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of RUNNER_GIT_ENV_ALLOWED) {
    const value = source[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  return { ...env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
}

export type GitRunner = (args: readonly string[], env: Readonly<Record<string, string>>) => Promise<string>;

export async function runGit(
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<string> {
  const subcommand = args.find((arg) => !arg.startsWith('-') && !arg.startsWith('/')) ?? 'git';
  const child = spawn('git', [...args], {
    env,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: GIT_TIMEOUT_MS,
  });
  const chunks: Buffer[] = [];
  let size = 0;
  child.stdout.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size <= GIT_OUTPUT_MAX_BYTES) {
      chunks.push(chunk);
    }
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
  if (exitCode !== 0 || size > GIT_OUTPUT_MAX_BYTES) {
    throw new GitError(subcommand, exitCode);
  }
  return Buffer.concat(chunks).toString('utf8');
}
