import {
  chmodSync,
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
 * line, and its group is killed only while the process with the recorded pid is still that server: every argument
 * after the executable is the one the stack started it with, the token last (`serverArgs`). One more case: the
 * server itself was killed and the workerd it forked lives on, holding the port. That group has no leader to carry a
 * token, and "all workerd" alone would also fit the leftover of some other Miniflare whose leader took the recorded
 * pid after ours was gone (#993). So every member has to look like this stack's own workerd: started by the path
 * of the one in this checkout, serving on the very port the record is filed under (`isStackWorkerd`).
 *
 * What the rule reads is the argument words of a process (`process-group.ts`), and it compares whole words (#999):
 * - It trusts their text. `argv[0]` is what the starter wrote there, not the file that runs: nothing here checks the
 *   executable itself.
 * - A word that only holds the token or the socket address among other text is not that word. Linux hands out the
 *   real words, so there this is exact. On macOS they come from `ps`, joined and split at spaces again, so a word
 *   with spaces arrives in pieces: for a live leader the pieces then have to be the server's arguments, all of them
 *   and in order, to match — text that spells out the whole command line cannot be told from it — and for a workerd
 *   one piece has to be the socket address.
 * - For the same reason a checkout whose path has a space never matches on macOS — neither the server's script nor
 *   the workerd path arrives as one word — and its leftovers are left alone: the rule fails closed, and the start
 *   reports the port still taken.
 * - The text is not all a live leader is known by (#1006): the record also holds when the system started the
 *   server (`GroupMember.startedAt`), which no process writes for itself, and the leader has to have started at that
 *   very moment. So a process that took the recorded pid later is left alone even when its command line spells the
 *   server's out, token and all — on macOS, where the words are only text, as on Linux.
 * - Left open (pid reuse, #993): a Miniflare started from this same checkout by something other than the suite, on
 *   a port inside the suite's own range, whose leader took the recorded pid and then died. Its workerd is taken for
 *   the stack's and killed. It would be holding the very port the stack is about to bind. The start time does not
 *   close this one: the recorded leader is gone, and a workerd it forked started at some later moment of its own.
 *
 * A record names a process to kill, so only its owner may read or write it: mode 0600 (#1006).
 */
export interface ServerRecord {
  /** The server's pid, which is also its process group. */
  readonly pid: number;
  readonly token: string;
  readonly label: string;
  /** When the system started the server (`GroupMember.startedAt`), read right after the spawn (`startedAtOf`). */
  readonly startedAt: string;
}

/** The argument that carries a server's token; `serve-worker.mts` ignores it. */
export const SERVER_TOKEN_FLAG = '--stack-server=';

/** Each server of the stack is a Worker on Miniflare, not a `wrangler dev` (#957, `serve-worker.mts`). */
export const SERVE_WORKER = join(__dirname, 'serve-worker.mts');

/**
 * What a server is started with after the node executable. `local-stack.ts` starts it with exactly these and
 * `isRecorded` expects exactly these back, so the two cannot drift apart.
 */
export function serverArgs(token: string): string[] {
  return ['--experimental-strip-types', SERVE_WORKER, `${SERVER_TOKEN_FLAG}${token}`];
}

const KILL_TIMEOUT_MS = 5_000;
/** How Miniflare starts it: `<path>/workerd serve --binary … --socket-addr=entry=<host>:<port> …`. */
const WORKERD_FILE = 'workerd';
const WORKERD_VERB = 'serve';
const STACK_HOST = '127.0.0.1';

export type { GroupMember } from './process-group';

export interface StaleServerControl {
  /** Every running process of the group `pgid` with its argument words; none when the group is gone. */
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

const RECORD_MODE = 0o600;

/**
 * When the system started the leader of the group `pid`, for its record; `null` when it is not running (any more).
 * Read through `groupOf`, so the record and the later check take it from the same source.
 */
export function startedAtOf(pid: number, control: StaleServerControl = SYSTEM_CONTROL): string | null {
  return control.groupOf(pid).find((member) => member.pid === pid)?.startedAt ?? null;
}

/**
 * Files `record` under `port`: the port is part of what identifies the server later (`isStackWorkerd`).
 *
 * Whatever is at the path goes first, and the record is then created anew (`wx`): a mode only applies to a file
 * being created, so a record left open to others would stay open, and a link put there would be written through.
 * The `chmod` is for a umask that takes owner bits away; it cannot give others any.
 */
export function recordServer(dir: string, port: number, record: ServerRecord): void {
  mkdirSync(dir, { recursive: true });
  const path = recordPath(dir, port);
  rmSync(path, { force: true });
  writeFileSync(path, JSON.stringify(record), { mode: RECORD_MODE, flag: 'wx' });
  chmodSync(path, RECORD_MODE);
}

/** Drops the record of `port` if it is still `pid`'s: a later server on the same port keeps its own. */
export function forgetServer(dir: string, port: number, pid: number): void {
  const path = recordPath(dir, port);
  if (readRecord(path)?.pid === pid) {
    rmSync(path, { force: true });
  }
}

/**
 * `null` for a missing or unreadable record: a run killed mid-write leaves one, and it names nothing to stop. So
 * does a record from before the start time was kept (#1006): without one the server cannot be told from a process
 * that took its pid, and it is left alone.
 */
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
  const { pid, token, label, startedAt } = parsed as Record<string, unknown>;
  return typeof pid === 'number' &&
    Number.isInteger(pid) &&
    pid > 1 &&
    typeof token === 'string' &&
    token !== '' &&
    typeof label === 'string' &&
    typeof startedAt === 'string' &&
    startedAt !== ''
    ? { pid, token, label, startedAt }
    : null;
}

export interface StopStaleOptions {
  /** Only the records of these ports; every record of `dir` when left out. */
  readonly ports?: readonly number[];
  readonly control?: StaleServerControl;
  /** The directory this stack's workerd runs from; this checkout's `node_modules` when left out. */
  readonly workerdRoot?: string;
  /** The arguments a server with this token was started with; `serverArgs` when left out. */
  readonly serverArgs?: (token: string) => readonly string[];
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
      isRecorded(record, portOf(path), group, {
        workerdRoot: options.workerdRoot ?? installedModulesRoot(),
        serverArgs: (options.serverArgs ?? serverArgs)(record.token),
      })
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

export interface StackIdentity {
  /** The directory this stack's workerd runs from. */
  readonly workerdRoot: string;
  /** Every argument the recorded server was started with, after the executable. */
  readonly serverArgs: readonly string[];
}

/**
 * Whether `group` — the processes of the group `record.pid` now — is the server `record` was written for. A live
 * leader is, when it started at the recorded moment and its arguments after the executable are the server's own,
 * word for word and nothing more: a word that merely contains the token among other text is not one of them.
 */
export function isRecorded(
  record: ServerRecord,
  port: number,
  group: readonly GroupMember[],
  stack: StackIdentity,
): boolean {
  const leader = group.find((member) => member.pid === record.pid);
  if (leader !== undefined) {
    const args = leader.argv.slice(1);
    return (
      leader.startedAt === record.startedAt &&
      stack.serverArgs.includes(`${SERVER_TOKEN_FLAG}${record.token}`) &&
      args.length === stack.serverArgs.length &&
      args.every((word, at) => word === stack.serverArgs[at])
    );
  }
  return group.length > 0 && group.every((member) => isStackWorkerd(member.argv, port, stack.workerdRoot));
}

/**
 * Whether `argv` is the workerd of a server of this stack on `port`: `argv[0]` names a file `workerd` under
 * `workerdRoot` (this checkout's `node_modules`, where Miniflare takes it from), run as `workerd serve`, and one
 * whole word is the stack's address with exactly that port. A workerd of another checkout or tool, or of this one on
 * another port, is not. `argv[0]` is text the starter chose — see the limits in the note at the top.
 */
export function isStackWorkerd(argv: readonly string[], port: number, workerdRoot: string): boolean {
  const [executable, verb, ...args] = argv;
  if (!Number.isInteger(port) || executable === undefined || verb !== WORKERD_VERB) {
    return false;
  }
  const segments = executable.split(sep);
  return (
    executable.startsWith(workerdRoot.endsWith(sep) ? workerdRoot : `${workerdRoot}${sep}`) &&
    segments.at(-1) === WORKERD_FILE &&
    !segments.includes('..') &&
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
