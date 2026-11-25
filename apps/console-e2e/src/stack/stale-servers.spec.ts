import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isAlive } from './process-signal';
import {
  forgetServer,
  recordServer,
  parsePsListing,
  SERVER_TOKEN_FLAG,
  stopStaleServers,
  type GroupMember,
  type StaleServerControl,
} from './stale-servers';

let dir: string;
const children: ChildProcess[] = [];

/** A stand-in server: an idle node in its own process group, with a token on its command line. */
function startIdleServer(token: string): Promise<number> {
  const child = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)', '--', `${SERVER_TOKEN_FLAG}${token}`],
    { detached: true, stdio: 'ignore' },
  );
  children.push(child);
  return new Promise<number>((started, fail) => {
    child.once('error', fail);
    child.once('spawn', () => started(child.pid ?? 0));
  });
}

/** A process table the fake control answers from; `killGroup` empties the group. */
/** How the stand-in with `pid` ended; waits for this process to reap it (until then it is a zombie). */
function exitSignal(pid: number): Promise<NodeJS.Signals | null> {
  const child = children.find((candidate) => candidate.pid === pid);
  if (child === undefined) {
    throw new Error(`no stand-in server with pid ${pid}`);
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.signalCode);
  }
  return new Promise((ended) => child.once('exit', (_code, signal) => ended(signal)));
}

function control(groups: Record<number, GroupMember[]>): StaleServerControl & { killed: number[] } {
  const killed: number[] = [];
  return {
    killed,
    groupOf: (pgid) => groups[pgid] ?? [],
    killGroup: (pgid) => {
      killed.push(pgid);
      groups[pgid] = [];
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stale-servers-'));
});

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('stopStaleServers', () => {
  it('kills the process group a record points at and drops the record', async () => {
    const token = randomUUID();
    const pid = await startIdleServer(token);
    recordServer(dir, 8700, { pid, token, label: 'worker-0 api' });

    const stopped = await stopStaleServers(dir);

    expect(stopped).toEqual([`worker-0 api (pid ${pid})`]);
    expect(await exitSignal(pid)).toBe('SIGKILL');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('leaves a live process alone when its command line does not carry the recorded token (a reused pid)', async () => {
    const pid = await startIdleServer(randomUUID());
    recordServer(dir, 8700, { pid, token: randomUUID(), label: 'worker-0 api' });

    const stopped = await stopStaleServers(dir);

    expect(stopped).toEqual([]);
    expect(isAlive(pid)).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('drops the record of a server that is already gone, without signalling anything', async () => {
    const table = control({});
    recordServer(dir, 8700, { pid: 4242, token: 't', label: 'worker-0 api' });

    const stopped = await stopStaleServers(dir, undefined, table);

    expect(stopped).toEqual([]);
    expect(table.killed).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('kills the workerd a killed server left holding its port: a group without its leader, all workerd', async () => {
    const table = control({
      4242: [
        { pid: 4250, command: '/repo/node_modules/@cloudflare/workerd-darwin-arm64/bin/workerd serve -' },
      ],
    });
    recordServer(dir, 8700, { pid: 4242, token: 't', label: 'worker-0 api' });

    const stopped = await stopStaleServers(dir, undefined, table);

    expect(stopped).toEqual(['worker-0 api (pid 4242)']);
    expect(table.killed).toEqual([4242]);
  });

  it('leaves a leaderless group alone when a member is not workerd', async () => {
    const table = control({
      4242: [
        { pid: 4250, command: '/repo/node_modules/@cloudflare/workerd-darwin-arm64/bin/workerd serve -' },
        { pid: 4251, command: 'vim notes-on-workerd.md' },
      ],
    });
    recordServer(dir, 8700, { pid: 4242, token: 't', label: 'worker-0 api' });

    const stopped = await stopStaleServers(dir, undefined, table);

    expect(stopped).toEqual([]);
    expect(table.killed).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('stops only the servers on the given ports', async () => {
    const table = control({
      4242: [{ pid: 4242, command: `node serve-worker.mts ${SERVER_TOKEN_FLAG}a` }],
      4343: [{ pid: 4343, command: `node serve-worker.mts ${SERVER_TOKEN_FLAG}b` }],
    });
    recordServer(dir, 8700, { pid: 4242, token: 'a', label: 'worker-0 api' });
    recordServer(dir, 8710, { pid: 4343, token: 'b', label: 'worker-1 api' });

    const stopped = await stopStaleServers(dir, [8700, 8701], table);

    expect(stopped).toEqual(['worker-0 api (pid 4242)']);
    expect(table.killed).toEqual([4242]);
    expect(readdirSync(dir)).toEqual(['8710.json']);
  });

  it('drops a record cut short by a kill mid-write, and one that names pid 1: neither names a server', async () => {
    const table = control({ 1: [{ pid: 1, command: `init ${SERVER_TOKEN_FLAG}t` }] });
    writeFileSync(join(dir, '8700.json'), '{"pid": 42');
    writeFileSync(join(dir, '8701.json'), JSON.stringify({ pid: 1, token: 't', label: 'init' }));

    const stopped = await stopStaleServers(dir, undefined, table);

    expect(stopped).toEqual([]);
    expect(table.killed).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('answers nothing when no run has left records', async () => {
    expect(await stopStaleServers(join(dir, 'never-created'))).toEqual([]);
  });

  it('throws when a server outlives its SIGKILL, so the start does not go on to a taken port', async () => {
    vi.useFakeTimers();
    try {
      recordServer(dir, 8700, { pid: 4242, token: 'a', label: 'worker-0 api' });
      const stuck: StaleServerControl = {
        groupOf: () => [{ pid: 4242, command: `node ${SERVER_TOKEN_FLAG}a` }],
        killGroup: vi.fn(),
      };

      const outcome = expect(stopStaleServers(dir, undefined, stuck)).rejects.toThrow(/still running/);
      await vi.advanceTimersByTimeAsync(6_000);

      await outcome;
    } finally {
      vi.useRealTimers();
    }
  });
});

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

describe('forgetServer', () => {
  it('drops the record of the server that stopped', () => {
    recordServer(dir, 8700, { pid: 4242, token: 'a', label: 'worker-0 api' });

    forgetServer(dir, 8700, 4242);

    expect(existsSync(join(dir, '8700.json'))).toBe(false);
  });

  it('keeps the record of a later server on the same port', () => {
    recordServer(dir, 8700, { pid: 4343, token: 'b', label: 'worker-0 api' });

    forgetServer(dir, 8700, 4242);

    expect(existsSync(join(dir, '8700.json'))).toBe(true);
  });
});
