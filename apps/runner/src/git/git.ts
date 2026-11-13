import { spawn } from 'node:child_process';

/**
 * `git` as the runner runs it: no shell, a fixed env without any `GIT_*` of the runner's process (`GIT_CONFIG_*`
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

/** The runner's env for git: its own HOME and PATH (the mirror fetch uses the runner's read access), no `GIT_*`. */
export function runnerGitEnv(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && !name.startsWith('GIT_')) {
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
