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
}

/** Every running process of the group `pgid` with its argument words; none when the group is gone. */
export function groupOf(pgid: number): GroupMember[] {
  return existsSync('/proc/self/stat') ? groupFromProc(pgid) : groupFromPs(pgid);
}

/**
 * Linux: `/proc/<pid>/stat` is `pid (comm) state ppid pgrp …`, and `comm` may hold spaces and brackets itself. A
 * zombie (`Z`) is left out: it holds no port, and under a pid 1 that reaps nothing (a CI container) it never leaves.
 * A line too short to carry a start time is not a process to match on either.
 */
function groupFromProc(pgid: number): GroupMember[] {
  const members: GroupMember[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    try {
      const stat = parseProcStat(readFileSync(`/proc/${entry}/stat`, 'utf8'));
      if (stat !== null && stat.pgrp === pgid && stat.state !== 'Z') {
        members.push({
          pid: Number(entry),
          argv: parseProcCmdline(readFileSync(`/proc/${entry}/cmdline`, 'utf8')),
          startedAt: stat.startedAt,
        });
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

export interface ProcStat {
  readonly state: string;
  readonly pgrp: number;
  readonly startedAt: string;
}

/** `state` is field 3 of `proc(5)`'s stat line, the first after `(comm)`; `pgrp` is field 5, `starttime` field 22. */
const STAT_FIELDS_AFTER_COMM = { state: 0, pgrp: 2, starttime: 19 } as const;

/**
 * What `groupFromProc` needs of a `/proc/<pid>/stat` line, read after the last `)`: `comm` is the process's own text
 * and may hold brackets and spaces. `null` for a line without those fields.
 */
export function parseProcStat(stat: string): ProcStat | null {
  const fields = stat
    .slice(stat.lastIndexOf(')') + 2)
    .trimEnd()
    .split(' ');
  const state = fields[STAT_FIELDS_AFTER_COMM.state];
  const pgrp = fields[STAT_FIELDS_AFTER_COMM.pgrp];
  const startedAt = fields[STAT_FIELDS_AFTER_COMM.starttime];
  if (state === undefined || pgrp === undefined || startedAt === undefined || !/^\d+$/.test(startedAt)) {
    return null;
  }
  return { state, pgrp: Number(pgrp), startedAt };
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
    }
  }
  return members;
}
