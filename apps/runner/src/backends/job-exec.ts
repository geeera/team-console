import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { constants as osConstants } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import type { Readable } from 'node:stream';
import { BackendError, type LaunchSpec } from './backend';

/**
 * `job-exec run`: the job side of the `user` and `container` backends (ADR 0008 decisions 3, 11, 12). The runner
 * hands the launch over on stdin, so the job token and the credential never appear in argv (`ps`), a sudo log, a
 * file or `docker inspect`; this process runs it with exactly that env as the job's user and exits with its status.
 * It is what the one sudoers rule allows and the image's job entrypoint (`bin/job-exec`).
 */

export interface JobExecSpec {
  readonly command: string;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
}

const SPEC_MAX_BYTES = 1024 * 1024;
const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];

export const jobExecSpecOf = (spec: Pick<LaunchSpec, 'command' | 'argv' | 'env' | 'cwd'>): string =>
  JSON.stringify({ command: spec.command, argv: spec.argv, env: spec.env, cwd: spec.cwd });

const isStringRecord = (value: unknown): value is Record<string, string> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((entry) => typeof entry === 'string');

export function parseJobExecSpec(text: string): JobExecSpec {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new BackendError('job-exec: stdin is not a JSON launch spec');
  }
  if (typeof value !== 'object' || value === null) {
    throw new BackendError('job-exec: stdin is not a JSON launch spec');
  }
  const { command, argv, env, cwd } = value as Record<string, unknown>;
  if (
    typeof command !== 'string' ||
    command === '' ||
    !Array.isArray(argv) ||
    !argv.every((arg) => typeof arg === 'string') ||
    !isStringRecord(env) ||
    typeof cwd !== 'string' ||
    !isAbsolute(cwd)
  ) {
    throw new BackendError('job-exec: the launch spec needs command, argv, env and an absolute cwd');
  }
  return { command, argv: argv as string[], env, cwd };
}

/** The command as the job's own `PATH` finds it; the runner's `PATH` never decides what the job runs. */
export async function resolveCommand(command: string, path: string | undefined): Promise<string> {
  if (command.includes('/')) {
    return command;
  }
  for (const dir of (path ?? '').split(delimiter).filter((entry) => isAbsolute(entry))) {
    const candidate = join(dir, command);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here; the next directory of PATH decides.
    }
  }
  throw new BackendError(`job-exec: ${command} is not on the job's PATH`);
}

async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > SPEC_MAX_BYTES) {
      throw new BackendError('job-exec: the launch spec is too large');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Runs the spec on stdin; returns the exit status the caller should exit with (128 + n for a signal). */
export async function runJobExec(stdin: Readable, uid: number | null): Promise<number> {
  if (uid === 0) {
    throw new BackendError('job-exec never runs a job as root');
  }
  const spec = parseJobExecSpec(await readAll(stdin));
  const command = await resolveCommand(spec.command, spec.env['PATH']);
  const child = spawn(command, [...spec.argv], {
    cwd: spec.cwd,
    env: { ...spec.env },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const forward = (signal: NodeJS.Signals): void => {
    child.kill(signal);
  };
  for (const signal of FORWARDED_SIGNALS) {
    process.on(signal, forward);
  }
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) =>
        resolve(signal === null ? (code ?? 1) : 128 + (osConstants.signals[signal] ?? 0)),
      );
    });
  } finally {
    for (const signal of FORWARDED_SIGNALS) {
      process.off(signal, forward);
    }
  }
}
