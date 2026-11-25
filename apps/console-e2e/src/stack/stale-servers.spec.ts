import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isAlive } from './process-signal';
import type { GroupMember } from './process-group';
import {
  forgetServer,
  isStackWorkerd,
  recordServer,
  SERVER_TOKEN_FLAG,
  stopStaleServers,
  type StaleServerControl,
} from './stale-servers';

/** This checkout's `node_modules` in the fake process tables, and the workerd Miniflare starts from it on `port`. */
const ROOT = '/repo/node_modules';
function workerd(port: number, root = ROOT): string {
  return `${root}/@cloudflare/workerd-darwin-arm64/bin/workerd serve --binary --experimental --socket-addr=entry=127.0.0.1:${port} --external-addr=loopback=127.0.0.1:50123 --control-fd=3 - --inspector-addr=127.0.0.1:${port + 1}`;
}

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

    const stopped = await stopStaleServers(dir, { control: table, workerdRoot: ROOT });

    expect(stopped).toEqual([]);
    expect(table.killed).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('kills the workerd a killed server left holding its port: a leaderless group of the workerd of this checkout on that port', async () => {
    const table = control({ 4242: [{ pid: 4250, command: workerd(8700) }] });
    recordServer(dir, 8700, { pid: 4242, token: 't', label: 'worker-0 api' });

    const stopped = await stopStaleServers(dir, { control: table, workerdRoot: ROOT });

    expect(stopped).toEqual(['worker-0 api (pid 4242)']);
    expect(table.killed).toEqual([4242]);
  });

  it.each([
    [
      'a workerd of another checkout that took the recorded pid as its group',
      workerd(8700, '/other/node_modules'),
    ],
    ['a workerd of this checkout serving another port', workerd(8800)],
    ['a workerd whose port only starts with the recorded one', workerd(87001)],
    ['a workerd with no socket address', `${ROOT}/@cloudflare/workerd-darwin-arm64/bin/workerd serve -`],
    [
      'a path under this checkout that only mentions workerd',
      `${ROOT}/.bin/not-workerd serve --socket-addr=entry=127.0.0.1:8700`,
    ],
  ])('leaves a leaderless group alone when it is %s', async (_what, command) => {
    const table = control({ 4242: [{ pid: 4250, command }] });
    recordServer(dir, 8700, { pid: 4242, token: 't', label: 'worker-0 api' });

    const stopped = await stopStaleServers(dir, { control: table, workerdRoot: ROOT });

    expect(stopped).toEqual([]);
    expect(table.killed).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('leaves a leaderless group alone when one member is not the workerd of this stack', async () => {
    const table = control({
      4242: [
        { pid: 4250, command: workerd(8700) },
        { pid: 4251, command: 'vim notes-on-workerd.md' },
      ],
    });
    recordServer(dir, 8700, { pid: 4242, token: 't', label: 'worker-0 api' });

    const stopped = await stopStaleServers(dir, { control: table, workerdRoot: ROOT });

    expect(stopped).toEqual([]);
    expect(table.killed).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('leaves a live leader alone when its token is only a prefix of the one it carries', async () => {
    const table = control({
      4242: [{ pid: 4242, command: `node serve-worker.mts ${SERVER_TOKEN_FLAG}abc-longer` }],
    });
    recordServer(dir, 8700, { pid: 4242, token: 'abc', label: 'worker-0 api' });

    const stopped = await stopStaleServers(dir, { control: table, workerdRoot: ROOT });

    expect(stopped).toEqual([]);
    expect(table.killed).toEqual([]);
  });

  it('stops only the servers on the given ports', async () => {
    const table = control({
      4242: [{ pid: 4242, command: `node serve-worker.mts ${SERVER_TOKEN_FLAG}a` }],
      4343: [{ pid: 4343, command: `node serve-worker.mts ${SERVER_TOKEN_FLAG}b` }],
    });
    recordServer(dir, 8700, { pid: 4242, token: 'a', label: 'worker-0 api' });
    recordServer(dir, 8710, { pid: 4343, token: 'b', label: 'worker-1 api' });

    const stopped = await stopStaleServers(dir, { ports: [8700, 8701], control: table, workerdRoot: ROOT });

    expect(stopped).toEqual(['worker-0 api (pid 4242)']);
    expect(table.killed).toEqual([4242]);
    expect(readdirSync(dir)).toEqual(['8710.json']);
  });

  it('drops a record cut short by a kill mid-write, and one that names pid 1: neither names a server', async () => {
    const table = control({ 1: [{ pid: 1, command: `init ${SERVER_TOKEN_FLAG}t` }] });
    writeFileSync(join(dir, '8700.json'), '{"pid": 42');
    writeFileSync(join(dir, '8701.json'), JSON.stringify({ pid: 1, token: 't', label: 'init' }));

    const stopped = await stopStaleServers(dir, { control: table, workerdRoot: ROOT });

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

      const outcome = expect(stopStaleServers(dir, { control: stuck })).rejects.toThrow(/still running/);
      await vi.advanceTimersByTimeAsync(6_000);

      await outcome;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('isStackWorkerd', () => {
  it('accepts the workerd of this checkout on the port, also when the checkout path has spaces', () => {
    expect(isStackWorkerd(workerd(8700), 8700, ROOT)).toBe(true);
    expect(isStackWorkerd(workerd(8700, '/my repo/node_modules'), 8700, '/my repo/node_modules')).toBe(true);
  });

  it('refuses a path that leaves the checkout, a sibling directory, and a record with no port', () => {
    expect(isStackWorkerd(workerd(8700, `${ROOT}/../../other/node_modules`), 8700, ROOT)).toBe(false);
    expect(isStackWorkerd(workerd(8700, `${ROOT}-copy`), 8700, ROOT)).toBe(false);
    expect(isStackWorkerd(workerd(8700), Number.NaN, ROOT)).toBe(false);
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
