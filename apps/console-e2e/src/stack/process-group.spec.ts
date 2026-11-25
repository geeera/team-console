import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { groupOf, parsePsListing } from './process-group';

describe('parsePsListing', () => {
  const listing = [
    '    1     1 Ss   /sbin/launchd',
    ' 4242  4242 S    node --experimental-strip-types serve-worker.mts --stack-server=abc',
    ' 4250  4242 S    /repo/node_modules/@cloudflare/workerd-darwin-arm64/bin/workerd serve --binary -',
    ' 4260  4242 Z    (node)',
    ' 5000  5000 R+   ps -A -ww -o pid=,pgid=,stat=,command=',
    '',
  ].join('\n');

  it('picks the running members of the group with their whole command lines', () => {
    expect(parsePsListing(listing, 4242)).toEqual([
      { pid: 4242, command: 'node --experimental-strip-types serve-worker.mts --stack-server=abc' },
      {
        pid: 4250,
        command: '/repo/node_modules/@cloudflare/workerd-darwin-arm64/bin/workerd serve --binary -',
      },
    ]);
  });

  it('answers none for a group that is gone or only has zombies left', () => {
    expect(parsePsListing(listing, 9999)).toEqual([]);
    expect(parsePsListing(' 4260  4242 Z    (node)\n', 4242)).toEqual([]);
  });
});

describe('groupOf', () => {
  it('finds a live process group leader with its command line, and nothing once it is gone', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', 'group-of-spec'], {
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
      expect(members[0]?.command).toContain('group-of-spec');
    } finally {
      const exited = new Promise<void>((done) => child.once('exit', () => done()));
      child.kill('SIGKILL');
      await exited;
    }

    expect(groupOf(pid)).toEqual([]);
  });
});
