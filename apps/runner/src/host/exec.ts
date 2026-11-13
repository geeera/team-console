import { spawn as spawnChild } from 'node:child_process';
import type { Readable } from 'node:stream';

/**
 * Host commands the runner runs (`lsof`, `sudo`, `pgrep`, the container runtime, the installer's `dscl`): no shell,
 * a fixed env, stdin as data only. One seam, so every backend and the installer are driven by a fake in their specs
 * and the exact command sequence is what they assert.
 */

export interface ExecResult {
  readonly code: number | null;
  readonly stdout: string;
}

export interface ExecOptions {
  /** Written to the command's stdin, then closed; a launch spec travels here, never in argv. */
  readonly stdin?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
}

export type Exec = (command: string, args: readonly string[], options?: ExecOptions) => Promise<ExecResult>;

export interface SpawnedProcess {
  readonly pid: number | undefined;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exited: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
}

/** A long-running command whose output streams (a job); stdin is written once and closed. */
export type Spawn = (
  command: string,
  args: readonly string[],
  options: ExecOptions,
) => Promise<SpawnedProcess>;

export const SYSTEM_PATH = '/usr/sbin:/usr/bin:/sbin:/bin';
const OUTPUT_MAX_BYTES = 4 * 1024 * 1024;

export const hostExec: Exec = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawnChild(command, [...args], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { PATH: SYSTEM_PATH, ...options.env },
    });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (stdout.length < OUTPUT_MAX_BYTES) {
        stdout += chunk;
      }
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout }));
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.stdin ?? '');
  });

export const hostSpawn: Spawn = async (command, args, options) => {
  const child = spawnChild(command, [...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: SYSTEM_PATH, ...options.env },
    // Its own process group, so the runner's Ctrl-C does not reach the job before the runner has finished it.
    detached: true,
  });
  const exited = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
    child.once('error', () => resolve({ exitCode: null, signal: null }));
  });
  await new Promise<void>((resolve) => {
    child.once('spawn', resolve);
    child.once('error', () => resolve());
  });
  // A job that never reads stdin must not fail the write; the spec is small and written at once.
  child.stdin.on('error', () => undefined);
  child.stdin.end(options.stdin ?? '');
  return { pid: child.pid, stdout: child.stdout, stderr: child.stderr, exited };
};
