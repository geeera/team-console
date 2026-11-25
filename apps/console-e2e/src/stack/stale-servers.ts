import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAlive, signal } from './process-signal';

/**
 * Stack servers a run left behind (#982). A server normally stops with its Playwright worker, or by itself when the
 * worker is gone (`orphan-watch.mts`); this is the net under both: every server is recorded in a file named by its
 * port, and the next start stops whatever a record still points at before it needs that port.
 *
 * A pid alone is not proof — the system reuses pids — so each server is started with a random token on its command
 * line, and a record is acted on only while the process with its pid still carries that token.
 */
export interface ServerRecord {
  /** The server's pid, which is also its process group. */
  readonly pid: number;
  readonly token: string;
  readonly label: string;
}

/** The argument that carries a server's token; `serve-worker.mts` ignores it. */
export const SERVER_TOKEN_FLAG = '--stack-server=';

const KILL_TIMEOUT_MS = 5_000;

export interface StaleServerControl {
  /** The command line of `pid`; `null` when there is no such process. */
  commandOf(pid: number): string | null;
  killGroup(pid: number): void;
  isAlive(pid: number): boolean;
}

const SYSTEM_CONTROL: StaleServerControl = {
  commandOf,
  killGroup: (pid) => signal(-pid, 'SIGKILL', pid),
  isAlive,
};

function recordPath(dir: string, port: number): string {
  return join(dir, `${port}.json`);
}

export function recordServer(dir: string, port: number, record: ServerRecord): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(recordPath(dir, port), JSON.stringify(record));
}

/** Drops the record of `port` if it is still `pid`'s: a later server on the same port keeps its own. */
export function forgetServer(dir: string, port: number, pid: number): void {
  const path = recordPath(dir, port);
  if (readRecord(path)?.pid === pid) {
    rmSync(path, { force: true });
  }
}

/** `null` for a missing or unreadable record: a run killed mid-write leaves one, and it names nothing to stop. */
function readRecord(path: string): ServerRecord | null {
  if (!existsSync(path)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const { pid, token, label } = parsed as Record<string, unknown>;
  return typeof pid === 'number' &&
    Number.isInteger(pid) &&
    pid > 1 &&
    typeof token === 'string' &&
    token !== '' &&
    typeof label === 'string'
    ? { pid, token, label }
    : null;
}

function commandOf(pid: number): string | null {
  const proc = `/proc/${pid}/cmdline`;
  if (existsSync('/proc/self/cmdline')) {
    return existsSync(proc) ? readFileSync(proc, 'utf8').replaceAll('\0', ' ') : null;
  }
  try {
    return execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  } catch (error: unknown) {
    // ps exits 1 for a pid that does not exist; anything else (no ps at all) is a real failure.
    if (error instanceof Error && 'status' in error && error.status === 1) {
      return null;
    }
    throw error;
  }
}

/**
 * Stops the servers the records in `dir` still point at — all of them, or those on `ports` — and drops the records.
 * Returns what it stopped, for the caller to report.
 */
export async function stopStaleServers(
  dir: string,
  ports?: readonly number[],
  control: StaleServerControl = SYSTEM_CONTROL,
): Promise<string[]> {
  if (!existsSync(dir)) {
    return [];
  }
  const paths =
    ports === undefined
      ? readdirSync(dir)
          .filter((file) => file.endsWith('.json'))
          .map((file) => join(dir, file))
      : ports.map((port) => recordPath(dir, port));
  const stopped: string[] = [];
  for (const path of paths) {
    const record = readRecord(path);
    if (record !== null && isRecorded(record, control)) {
      control.killGroup(record.pid);
      await gone(record, control);
      stopped.push(`${record.label} (pid ${record.pid})`);
    }
    rmSync(path, { force: true });
  }
  return stopped;
}

function isRecorded(record: ServerRecord, control: StaleServerControl): boolean {
  return control.commandOf(record.pid)?.includes(`${SERVER_TOKEN_FLAG}${record.token}`) === true;
}

async function gone(record: ServerRecord, control: StaleServerControl): Promise<void> {
  const deadline = Date.now() + KILL_TIMEOUT_MS;
  while (control.isAlive(record.pid)) {
    if (Date.now() > deadline) {
      throw new Error(
        `${record.label} (pid ${record.pid}) is still running ${KILL_TIMEOUT_MS} ms after SIGKILL`,
      );
    }
    await new Promise<void>((done) => setTimeout(done, 50));
  }
}
