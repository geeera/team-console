import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { groupOf, parseProcCmdline, parseProcStat, parsePsListing, procMember } from './process-group';

describe('parsePsListing', () => {
  const listing = [
    '    1     1 Ss   Fri Nov 20 14:38:15 2026     /sbin/launchd',
    ' 4242  4242 S    Wed Nov 25 18:33:54 2026     node --experimental-strip-types serve-worker.mts --stack-server=abc',
    ' 4250  4242 S    Wed Nov 25 18:33:55 2026     /repo/node_modules/@cloudflare/workerd-darwin-arm64/bin/workerd serve --binary -',
    ' 4260  4242 Z    Wed Nov 25 18:33:56 2026     (node)',
    ' 5000  5000 R+   Wed Nov 25 18:34:00 2026     ps -A -ww -o pid=,pgid=,stat=,lstart=,command=',
    '',
  ].join('\n');

  it('picks the running members of the group with the words of their command lines', () => {
    expect(parsePsListing(listing, 4242)).toEqual([
      {
        pid: 4242,
        argv: ['node', '--experimental-strip-types', 'serve-worker.mts', '--stack-server=abc'],
        startedAt: 'Wed Nov 25 18:33:54 2026',
      },
      {
        pid: 4250,
        argv: ['/repo/node_modules/@cloudflare/workerd-darwin-arm64/bin/workerd', 'serve', '--binary', '-'],
        startedAt: 'Wed Nov 25 18:33:55 2026',
      },
    ]);
  });

  it('reads the start time the same whether or not ps padded the day of the month', () => {
    const padded = parsePsListing(' 4242  4242 S    Thu Nov  5 08:03:09 2026     node\n', 4242);

    expect(padded).toEqual([{ pid: 4242, argv: ['node'], startedAt: 'Thu Nov 5 08:03:09 2026' }]);
  });

  it('keeps a process whose command ps prints empty, with its start time', () => {
    expect(parsePsListing(' 4242  4242 S    Wed Nov 25 18:33:54 2026\n', 4242)).toEqual([
      { pid: 4242, argv: [], startedAt: 'Wed Nov 25 18:33:54 2026' },
    ]);
  });

  it('keeps a line of the group without a start time as a member it could not read, its command words not taken for one', () => {
    expect(parsePsListing(' 4242  4242 S    node serve-worker.mts\n', 4242)).toEqual([
      { pid: 4242, argv: [], startedAt: '', unreadable: true },
    ]);
    expect(parsePsListing(' 4250  4242\n', 4242)).toEqual([
      { pid: 4250, argv: [], startedAt: '', unreadable: true },
    ]);
  });

  it('lists the member it could not read next to those it could, so the group is not judged by the rest', () => {
    const cut = `${listing} 4270  4242 S    Wed Nov 25\n`;

    expect(parsePsListing(cut, 4242).map((member) => [member.pid, member.unreadable])).toEqual([
      [4242, undefined],
      [4250, undefined],
      [4270, true],
    ]);
  });

  it('leaves out an unreadable line of another group, a zombie, and the later lines of a command with a line break', () => {
    expect(parsePsListing(' 4242  9999 S    node serve-worker.mts\n', 4242)).toEqual([]);
    expect(parsePsListing(' 4260  4242 Z    (node)\n', 4242)).toEqual([]);
    expect(
      parsePsListing(' 4242  4242 S    Wed Nov 25 18:33:54 2026     node -e a\nb 4242 4242\n\n', 4242),
    ).toEqual([{ pid: 4242, argv: ['node', '-e', 'a'], startedAt: 'Wed Nov 25 18:33:54 2026' }]);
  });

  it('cannot give a word with spaces back: ps joined it with the rest, and every space splits', () => {
    expect(
      parsePsListing(' 4242  4242 S    Wed Nov 25 18:33:54 2026     /my repo/node -e a  b\n', 4242),
    ).toEqual([
      { pid: 4242, argv: ['/my', 'repo/node', '-e', 'a', '', 'b'], startedAt: 'Wed Nov 25 18:33:54 2026' },
    ]);
  });

  it('answers none for a group that is gone or only has zombies left', () => {
    expect(parsePsListing(listing, 9999)).toEqual([]);
    expect(parsePsListing(' 4260  4242 Z    Wed Nov 25 18:33:56 2026     (node)\n', 4242)).toEqual([]);
  });
});

describe('parseProcCmdline', () => {
  it('keeps each NUL-ended word whole, spaces and empty words included', () => {
    expect(parseProcCmdline('node\0-e\0run("x") // --stack-server=abc\0\0last\0')).toEqual([
      'node',
      '-e',
      'run("x") // --stack-server=abc',
      '',
      'last',
    ]);
  });

  it('answers no words for a process without a command line, and one for a rewritten title', () => {
    expect(parseProcCmdline('')).toEqual([]);
    expect(parseProcCmdline('nginx: worker process')).toEqual(['nginx: worker process']);
  });
});

/** A `/proc/<pid>/stat` line with `comm` and the three fields the group listing reads; the rest are zeros. */
function statLine(comm: string, state: string, pgrp: number, starttime: string): string {
  const afterComm = [state, '1', String(pgrp), ...Array<string>(16).fill('0'), starttime, '0', '0'];
  return `4242 (${comm}) ${afterComm.join(' ')}\n`;
}

describe('parseProcStat', () => {
  it('reads the state, the group and the start time in clock ticks', () => {
    expect(parseProcStat(statLine('node', 'S', 4242, '8675309'))).toEqual({
      state: 'S',
      pgrp: 4242,
      startedAt: '8675309',
    });
  });

  it('reads past a name that holds brackets, spaces and numbers of its own', () => {
    expect(parseProcStat(statLine('a) R 1 7 (b', 'Z', 4242, '12'))).toEqual({
      state: 'Z',
      pgrp: 4242,
      startedAt: '12',
    });
  });

  it('reads no start time from a line that ends before it, or carries no number there', () => {
    expect(parseProcStat('4242 (node) S 1 4242 0\n')).toEqual({ state: 'S', pgrp: 4242, startedAt: null });
    expect(parseProcStat(statLine('node', 'S', 4242, 'soon'))).toEqual({
      state: 'S',
      pgrp: 4242,
      startedAt: null,
    });
  });

  it('answers nothing for a line that does not tell the group', () => {
    expect(parseProcStat('4242 (node) S 1\n')).toBeNull();
    expect(parseProcStat('4242 (node) S 1 group 0\n')).toBeNull();
    expect(parseProcStat('')).toBeNull();
  });
});

describe('procMember', () => {
  const words = (): string => 'node\0serve-worker.mts\0';
  const unread = (): string => {
    throw new Error('the command line of this process is not read');
  };

  it('is the process with its words and start time when it is a running member of the group', () => {
    expect(procMember(4250, 4242, statLine('node', 'S', 4242, '8675309'), words)).toEqual({
      pid: 4250,
      argv: ['node', 'serve-worker.mts'],
      startedAt: '8675309',
    });
  });

  it('is nothing for a process of another group and for a zombie, whose command lines are not read', () => {
    expect(procMember(4250, 4242, statLine('node', 'S', 9999, '8675309'), unread)).toBeNull();
    expect(procMember(4250, 4242, statLine('node', 'Z', 4242, '8675309'), unread)).toBeNull();
    expect(procMember(4250, 4242, '4250 (node) S 1 9999 0\n', unread)).toBeNull();
  });

  it('keeps a member of the group without a start time as one it could not read', () => {
    expect(procMember(4250, 4242, '4250 (node) S 1 4242 0\n', unread)).toEqual({
      pid: 4250,
      argv: [],
      startedAt: '',
      unreadable: true,
    });
  });

  it('keeps a member whose command line it may not read as one it could not read', () => {
    for (const code of ['EACCES', 'EPERM']) {
      const denied = (): string => {
        throw Object.assign(new Error(`${code}: permission denied, open '/proc/4250/cmdline'`), { code });
      };

      expect(procMember(4250, 4242, statLine('node', 'S', 4242, '8675309'), denied)).toEqual({
        pid: 4250,
        argv: [],
        startedAt: '',
        unreadable: true,
      });
    }
  });

  it('passes on any other failure of the command line read, a process gone by then included', () => {
    const gone = (): string => {
      throw Object.assign(new Error("ENOENT: no such file or directory, open '/proc/4250/cmdline'"), {
        code: 'ENOENT',
      });
    };

    expect(() => procMember(4250, 4242, statLine('node', 'S', 4242, '8675309'), gone)).toThrow(/ENOENT/);
  });

  it('keeps a process whose line does not tell the group as one it could not read: it may be of this one', () => {
    expect(procMember(4250, 4242, '4250 (node) S\n', unread)).toEqual({
      pid: 4250,
      argv: [],
      startedAt: '',
      unreadable: true,
    });
  });
});

describe('groupOf', () => {
  it('finds a live process group leader with its command line, and nothing once it is gone', async () => {
    // No word with a space: those come back whole only where the words are real (`GroupMember`).
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', '--', 'group-of-spec'], {
      detached: true,
      stdio: 'ignore',
    });
    await new Promise<void>((started, fail) => {
      child.once('error', fail);
      child.once('spawn', () => started());
    });
    const pid = child.pid ?? 0;

    try {
      const members = groupOf(pid);
      expect(members.map((member) => member.pid)).toEqual([pid]);
      expect(members[0]?.argv.slice(1)).toEqual(['-e', 'setInterval(()=>{},1000)', '--', 'group-of-spec']);
      expect(members[0]?.startedAt).toMatch(/\S/);
      expect(groupOf(pid)[0]?.startedAt).toBe(members[0]?.startedAt);
    } finally {
      const exited = new Promise<void>((done) => child.once('exit', () => done()));
      child.kill('SIGKILL');
      await exited;
    }

    expect(groupOf(pid)).toEqual([]);
  });
});
