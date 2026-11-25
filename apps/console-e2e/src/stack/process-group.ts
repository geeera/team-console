import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

/**
 * The process table as `stale-servers.ts` needs it: who is in a process group, and with which argument words.
 *
 * `argv` is only as exact as its source (#999). Linux hands out the real words (`/proc/<pid>/cmdline`, NUL-separated),
 * so a word with spaces stays one word. macOS has no such source short of native code: `ps` prints the words joined
 * by spaces, and they are split at every space again — a word with spaces comes back as several, and a path with
 * spaces as fragments. Whoever matches on `argv` has to hold under both (`stale-servers.ts` → `isRecorded`).
 *
 * `startedAt` is the one thing here a process cannot write itself (#1006): when the system started it. It is text
 * to compare for equality only, and only against a value read on the same machine since its last boot — Linux gives
 * clock ticks since boot (`starttime` of `/proc/<pid>/stat`), macOS the wall clock to the second (`ps -o lstart=`).
 */
export interface GroupMember {
  readonly pid: number;
  readonly argv: readonly string[];
  readonly startedAt: string;
  /**
   * Set for a process the system's line could not be read for (#1013): it is in the group, or may be, and its words
   * and start time are not known — `argv` and `startedAt` are empty. It stays listed, so whoever matches on the group
   * refuses all of it (`isRecorded`) rather than judge it by the members that could be read.
   */
  readonly unreadable?: true;
}

function unreadableMember(pid: number): GroupMember {
  return { pid, argv: [], startedAt: '', unreadable: true };
}

/** Every running process of the group `pgid` with its argument words; none when the group is gone. */
export function groupOf(pgid: number): GroupMember[] {
  return existsSync('/proc/self/stat') ? groupFromProc(pgid) : groupFromPs(pgid);
}

/**
 * Linux: `/proc/<pid>/stat` is `pid (comm) state ppid pgrp …`, and `comm` may hold spaces and brackets itself. A
 * zombie (`Z`) is left out: it holds no port, and under a pid 1 that reaps nothing (a CI container) it never leaves.
 * A line that cannot be read is not left out (`procMember`).
 */
function groupFromProc(pgid: number): GroupMember[] {
  const members: GroupMember[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    try {
      const member = procMember(Number(entry), pgid, readFileSync(`/proc/${entry}/stat`, 'utf8'), () =>
        readFileSync(`/proc/${entry}/cmdline`, 'utf8'),
      );
      if (member !== null) {
        members.push(member);
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

/**
 * The process `pid` as a member of `pgid`, from its `stat` line and, only when it is one, its `cmdline`; `null` for
 * a process of another group and for a zombie. A line that does not tell the group might be of any, this one too,
 * and one that tells this group but no start time is of it for sure: both are members that could not be read.
 */
export function procMember(
  pid: number,
  pgid: number,
  stat: string,
  cmdline: () => string,
): GroupMember | null {
  const parsed = parseProcStat(stat);
  if (parsed === null) {
    return unreadableMember(pid);
  }
  if (parsed.pgrp !== pgid || parsed.state === 'Z') {
    return null;
  }
  return parsed.startedAt === null
    ? unreadableMember(pid)
    : { pid, argv: parseProcCmdline(cmdline()), startedAt: parsed.startedAt };
}

export interface ProcStat {
  readonly state: string;
  readonly pgrp: number;
  /** `null` when the line ends before the start time or carries no number there. */
  readonly startedAt: string | null;
}

/** `state` is field 3 of `proc(5)`'s stat line, the first after `(comm)`; `pgrp` is field 5, `starttime` field 22. */
const STAT_FIELDS_AFTER_COMM = { state: 0, pgrp: 2, starttime: 19 } as const;

/**
 * What `groupFromProc` needs of a `/proc/<pid>/stat` line, read after the last `)`: `comm` is the process's own text
 * and may hold brackets and spaces. `null` for a line that does not tell the state and the group.
 */
export function parseProcStat(stat: string): ProcStat | null {
  const fields = stat
    .slice(stat.lastIndexOf(')') + 2)
    .trimEnd()
    .split(' ');
  const state = fields[STAT_FIELDS_AFTER_COMM.state];
  const pgrp = fields[STAT_FIELDS_AFTER_COMM.pgrp];
  const startedAt = fields[STAT_FIELDS_AFTER_COMM.starttime];
  if (state === undefined || state === '' || pgrp === undefined || !/^-?\d+$/.test(pgrp)) {
    return null;
  }
  return {
    state,
    pgrp: Number(pgrp),
    startedAt: startedAt !== undefined && /^\d+$/.test(startedAt) ? startedAt : null,
  };
}

/**
 * The words of a `/proc/<pid>/cmdline`: each ends in a NUL, so the words are what lies between them, spaces and
 * all. None for a process without a command line (a kernel thread); a process that overwrote its own (a "process
 * title") shows as the one word it wrote.
 */
export function parseProcCmdline(cmdline: string): string[] {
  if (cmdline === '') {
    return [];
  }
  return (cmdline.endsWith('\0') ? cmdline.slice(0, -1) : cmdline).split('\0');
}

function groupFromPs(pgid: number): GroupMember[] {
  const listing = execFileSync('ps', ['-A', '-ww', '-o', 'pid=,pgid=,stat=,lstart=,command='], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    // `lstart` is printed in the caller's locale and time zone; pinned, the same start reads the same in every run.
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
  });
  return parsePsListing(listing, pgid);
}

/**
 * The members of `pgid` in the output of `ps -o pid=,pgid=,stat=,lstart=,command=`, zombies (`Z…`) left out as
 * above. `lstart` is five words (`Wed Nov 25 18:33:54 2026`, the day padded with a space below 10), kept with single
 * spaces. The command is split at every single space: `ps` has already joined the words, so this cannot give a word
 * with spaces back (`GroupMember`). An empty word stays one, between two spaces.
 *
 * A line that names this group but not the rest — no start time where one belongs — is a member that could not be
 * read, and stays listed as one. A line that does not start with two numbers is no process of its own: `ps` prints
 * a command line with a line break in it over several lines, and those are its later ones.
 */
export function parsePsListing(listing: string, pgid: number): GroupMember[] {
  const members: GroupMember[] = [];
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)(?:\s+(.*))?$/.exec(line);
    if (match !== null && Number(match[2]) === pgid && !(match[3] ?? '').startsWith('Z')) {
      const command = (match[5] ?? '').trimEnd();
      members.push({
        pid: Number(match[1]),
        argv: command === '' ? [] : command.split(' '),
        startedAt: (match[4] ?? '').split(/\s+/).join(' '),
      });
    } else if (match === null) {
      const head = /^\s*(\d+)\s+(\d+)(?:\s+(\S+))?/.exec(line);
      if (head !== null && Number(head[2]) === pgid && !(head[3] ?? '').startsWith('Z')) {
        members.push(unreadableMember(Number(head[1])));
      }
    }
  }
  return members;
}
