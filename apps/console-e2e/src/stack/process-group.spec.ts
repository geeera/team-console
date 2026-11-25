import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { groupOf, parseProcCmdline, parseProcStat, parsePsListing } from './process-group';

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

  it('skips a line without a start time rather than taking command words for one', () => {
    expect(parsePsListing(' 4242  4242 S    node serve-worker.mts\n', 4242)).toEqual([]);
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

describe('parseProcStat', () => {
  /** A `/proc/<pid>/stat` line with `comm` and the three fields the group listing reads; the rest are zeros. */
  function statLine(comm: string, state: string, pgrp: number, starttime: string): string {
    const afterComm = [state, '1', String(pgrp), ...Array<string>(16).fill('0'), starttime, '0', '0'];
    return `4242 (${comm}) ${afterComm.join(' ')}\n`;
  }

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

  it('answers nothing for a line that ends before the start time, or carries no number there', () => {
    expect(parseProcStat('4242 (node) S 1 4242 0\n')).toBeNull();
    expect(parseProcStat(statLine('node', 'S', 4242, 'soon'))).toBeNull();
    expect(parseProcStat('')).toBeNull();
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
