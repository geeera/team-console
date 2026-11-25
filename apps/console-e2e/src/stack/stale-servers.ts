import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { signal } from './process-signal';

/**
 * Stack servers a run left behind (#982). A server normally stops with its Playwright worker, or by itself when the
 * worker is gone (`orphan-watch.mts`); this is the net under both: every server is recorded in a file named by its
 * port, and the next start stops whatever a record still points at before it needs that port.
 *
 * A pid alone is not proof — the system reuses pids — so each server is started with a random token on its command
 * line, and its group is killed only while the process with the recorded pid still carries that token. One more case:
 * the server itself was killed and the workerd it forked lives on, holding the port. The group's id cannot be reused
 * while the group has members, so a group with no leader whose members are all workerd is that server's.
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
const WORKERD = /(^|\/)workerd(\s|$)/;

export interface GroupMember {
  readonly pid: number;
  readonly command: string;
}

export interface StaleServerControl {
  /** Every running process of the group `pgid` with its command line; none when the group is gone. */
  groupOf(pgid: number): GroupMember[];
  killGroup(pgid: number): void;
}

const SYSTEM_CONTROL: StaleServerControl = {
  groupOf,
  killGroup: (pgid) => signal(-pgid, 'SIGKILL', pgid),
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

function groupOf(pgid: number): GroupMember[] {
  return existsSync('/proc/self/stat') ? groupFromProc(pgid) : groupFromPs(pgid);
}

/**
 * Linux: `/proc/<pid>/stat` is `pid (comm) state ppid pgrp …`, and `comm` may hold spaces and brackets itself. A
 * zombie (`Z`) is left out: it holds no port, and under a pid 1 that reaps nothing (a CI container) it never leaves.
 */
function groupFromProc(pgid: number): GroupMember[] {
  const members: GroupMember[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
      const [state, , pgrp] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(pgrp) === pgid && state !== 'Z') {
        const command = readFileSync(`/proc/${entry}/cmdline`, 'utf8').replaceAll('\0', ' ').trim();
        members.push({ pid: Number(entry), command });
      }
    } catch (error: unknown) {
      // A process that exited between the listing and the read is simply not in the group any more.
      if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ESRCH')) {
        continue;
      }
      throw error;
    }
  }
  return members;
}

function groupFromPs(pgid: number): GroupMember[] {
  const listing = execFileSync('ps', ['-A', '-ww', '-o', 'pid=,pgid=,stat=,command='], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return parsePsListing(listing, pgid);
}

/** The members of `pgid` in the output of `ps -o pid=,pgid=,stat=,command=`, zombies (`Z…`) left out as above. */
export function parsePsListing(listing: string, pgid: number): GroupMember[] {
  const members: GroupMember[] = [];
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (match !== null && Number(match[2]) === pgid && !(match[3] ?? '').startsWith('Z')) {
      members.push({ pid: Number(match[1]), command: (match[4] ?? '').trim() });
    }
  }
  return members;
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
    if (record !== null && isRecorded(record, control.groupOf(record.pid))) {
      control.killGroup(record.pid);
      await gone(record, control);
      stopped.push(`${record.label} (pid ${record.pid})`);
    }
    rmSync(path, { force: true });
  }
  return stopped;
}

function isRecorded(record: ServerRecord, group: readonly GroupMember[]): boolean {
  const leader = group.find((member) => member.pid === record.pid);
  if (leader !== undefined) {
    return leader.command.includes(`${SERVER_TOKEN_FLAG}${record.token}`);
  }
  return group.length > 0 && group.every((member) => WORKERD.test(member.command));
}

async function gone(record: ServerRecord, control: StaleServerControl): Promise<void> {
  const deadline = Date.now() + KILL_TIMEOUT_MS;
  while (control.groupOf(record.pid).length > 0) {
    if (Date.now() > deadline) {
      throw new Error(
        `${record.label} (pid ${record.pid}) is still running ${KILL_TIMEOUT_MS} ms after SIGKILL`,
      );
    }
    await new Promise<void>((done) => setTimeout(done, 100));
  }
}
