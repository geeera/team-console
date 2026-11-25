import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

/** The process table as `stale-servers.ts` needs it: who is in a process group, and with which command line. */
export interface GroupMember {
  readonly pid: number;
  readonly command: string;
}

/** Every running process of the group `pgid` with its command line; none when the group is gone. */
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
