import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { groupOf, parseProcCmdline, parsePsListing } from './process-group';

describe('parsePsListing', () => {
  const listing = [
    '    1     1 Ss   /sbin/launchd',
    ' 4242  4242 S    node --experimental-strip-types serve-worker.mts --stack-server=abc',
    ' 4250  4242 S    /repo/node_modules/@cloudflare/workerd-darwin-arm64/bin/workerd serve --binary -',
    ' 4260  4242 Z    (node)',
    ' 5000  5000 R+   ps -A -ww -o pid=,pgid=,stat=,command=',
    '',
  ].join('\n');

  it('picks the running members of the group with the words of their command lines', () => {
    expect(parsePsListing(listing, 4242)).toEqual([
      { pid: 4242, argv: ['node', '--experimental-strip-types', 'serve-worker.mts', '--stack-server=abc'] },
      {
        pid: 4250,
        argv: ['/repo/node_modules/@cloudflare/workerd-darwin-arm64/bin/workerd', 'serve', '--binary', '-'],
      },
    ]);
  });

  it('cannot give a word with spaces back: ps joined it with the rest, and every space splits', () => {
    expect(parsePsListing(' 4242  4242 S    /my repo/node -e a  b\n', 4242)).toEqual([
      { pid: 4242, argv: ['/my', 'repo/node', '-e', 'a', '', 'b'] },
    ]);
  });

  it('answers none for a group that is gone or only has zombies left', () => {
    expect(parsePsListing(listing, 9999)).toEqual([]);
    expect(parsePsListing(' 4260  4242 Z    (node)\n', 4242)).toEqual([]);
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

describe('groupOf', () => {
  it('finds a live process group leader with its command line, and nothing once it is gone', async () => {
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
    } finally {
      const exited = new Promise<void>((done) => child.once('exit', () => done()));
      child.kill('SIGKILL');
      await exited;
    }

    expect(groupOf(pid)).toEqual([]);
  });
});
