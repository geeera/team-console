import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

/**
 * The process table as `stale-servers.ts` needs it: who is in a process group, and with which argument words.
 *
 * `argv` is only as exact as its source (#999). Linux hands out the real words (`/proc/<pid>/cmdline`, NUL-separated),
 * so a word with spaces stays one word. macOS has no such source short of native code: `ps` prints the words joined
 * by spaces, and they are split at every space again — a word with spaces comes back as several, and a path with
 * spaces as fragments. Whoever matches on `argv` has to hold under both (`stale-servers.ts` → `isRecorded`).
 */
export interface GroupMember {
  readonly pid: number;
  readonly argv: readonly string[];
}

/** Every running process of the group `pgid` with its argument words; none when the group is gone. */
export function groupOf(pgid: number): GroupMember[] {
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
        members.push({
          pid: Number(entry),
          argv: parseProcCmdline(readFileSync(`/proc/${entry}/cmdline`, 'utf8')),
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
  const listing = execFileSync('ps', ['-A', '-ww', '-o', 'pid=,pgid=,stat=,command='], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return parsePsListing(listing, pgid);
}

/**
 * The members of `pgid` in the output of `ps -o pid=,pgid=,stat=,command=`, zombies (`Z…`) left out as above. The
 * command is split at every single space: `ps` has already joined the words, so this cannot give a word with spaces
 * back (`GroupMember`). An empty word stays one, between two spaces.
 */
export function parsePsListing(listing: string, pgid: number): GroupMember[] {
  const members: GroupMember[] = [];
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (match !== null && Number(match[2]) === pgid && !(match[3] ?? '').startsWith('Z')) {
      const command = (match[4] ?? '').trimEnd();
      members.push({ pid: Number(match[1]), argv: command === '' ? [] : command.split(' ') });
    }
  }
  return members;
}
