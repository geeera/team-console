import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, sep } from 'node:path';
import { groupOf, type GroupMember } from './process-group';
import { signal } from './process-signal';
import { WORKSPACE_ROOT } from './workspace';

/**
 * Stack servers a run left behind (#982). A server normally stops with its Playwright worker, or by itself when the
 * worker is gone (`orphan-watch.mts`); this is the net under both: every server is recorded in a file named by its
 * port, and the next start stops whatever a record still points at before it needs that port.
 *
 * A pid alone is not proof — the system reuses pids — so each server is started with a random token on its command
 * line, and its group is killed only while the process with the recorded pid still carries that token. One more case:
 * the server itself was killed and the workerd it forked lives on, holding the port. That group has no leader to
 * carry a token, and "all workerd" alone would also fit the leftover of some other Miniflare whose leader took the
 * recorded pid after ours was gone (#993). So every member has to be this stack's own workerd: the binary of this
 * checkout, serving on the very port the record is filed under (`isStackWorkerd`). Nothing but a server of this
 * stack on that port matches, and that is what the port has to be freed of.
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
/** Where Miniflare puts the executable's arguments: `<path>/workerd serve --binary … --socket-addr=entry=<host>:<port> …`. */
const WORKERD_SERVE = '/workerd serve ';
const STACK_HOST = '127.0.0.1';

export type { GroupMember } from './process-group';

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

/** Files `record` under `port`: the port is part of what identifies the server later (`isStackWorkerd`). */
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

export interface StopStaleOptions {
  /** Only the records of these ports; every record of `dir` when left out. */
  readonly ports?: readonly number[];
  readonly control?: StaleServerControl;
  /** The directory this stack's workerd runs from; this checkout's `node_modules` when left out. */
  readonly workerdRoot?: string;
}

/**
 * Stops the servers the records in `dir` still point at — all of them, or those on `ports` — and drops the records.
 * Returns what it stopped, for the caller to report.
 */
export async function stopStaleServers(dir: string, options: StopStaleOptions = {}): Promise<string[]> {
  if (!existsSync(dir)) {
    return [];
  }
  const { ports, control = SYSTEM_CONTROL } = options;
  const paths =
    ports === undefined
      ? readdirSync(dir)
          .filter((file) => file.endsWith('.json'))
          .map((file) => join(dir, file))
      : ports.map((port) => recordPath(dir, port));
  const stopped: string[] = [];
  for (const path of paths) {
    const record = readRecord(path);
    const group = record === null ? [] : control.groupOf(record.pid);
    if (
      record !== null &&
      group.length > 0 &&
      isRecorded(record, portOf(path), group, options.workerdRoot ?? installedModulesRoot())
    ) {
      control.killGroup(record.pid);
      await gone(record, control);
      stopped.push(`${record.label} (pid ${record.pid})`);
    }
    rmSync(path, { force: true });
  }
  return stopped;
}

/** The port a record is filed under (`recordPath`); `NaN` for a stray file, which then matches no workerd. */
function portOf(path: string): number {
  return Number(basename(path, '.json'));
}

/** Whether `group` — the processes of the group `record.pid` now — is the server `record` was written for. */
export function isRecorded(
  record: ServerRecord,
  port: number,
  group: readonly GroupMember[],
  workerdRoot: string,
): boolean {
  const leader = group.find((member) => member.pid === record.pid);
  if (leader !== undefined) {
    return leader.command.split(' ').includes(`${SERVER_TOKEN_FLAG}${record.token}`);
  }
  return group.length > 0 && group.every((member) => isStackWorkerd(member.command, port, workerdRoot));
}

/**
 * Whether `command` is the workerd of a server of this stack on `port`: the executable is a file named `workerd`
 * under `workerdRoot` (this checkout's `node_modules`, where Miniflare takes it from), and it serves the stack's
 * address with exactly that port. A workerd of another checkout or tool, or of this one on another port, is not.
 */
export function isStackWorkerd(command: string, port: number, workerdRoot: string): boolean {
  const end = command.indexOf(WORKERD_SERVE);
  if (!Number.isInteger(port) || end === -1) {
    return false;
  }
  const executable = command.slice(0, end + '/workerd'.length);
  const args = command.slice(end + WORKERD_SERVE.length).split(' ');
  return (
    executable.startsWith(workerdRoot.endsWith(sep) ? workerdRoot : `${workerdRoot}${sep}`) &&
    !executable.split(sep).includes('..') &&
    args.includes(`--socket-addr=entry=${STACK_HOST}:${port}`)
  );
}

/** Node resolves a package to its real path, so that is what the workerd command line shows. */
function installedModulesRoot(): string {
  return realpathSync(join(WORKSPACE_ROOT, 'node_modules'));
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
