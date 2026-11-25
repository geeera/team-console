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
  SERVER_TOKEN_FLAG,
  stopStaleServers,
  type StaleServerControl,
} from './stale-servers';

let dir: string;
const children: ChildProcess[] = [];

/** A stand-in server: an idle node in its own process group, with a token on its command line. */
function startIdleServer(token: string): Promise<number> {
  const child = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)', `${SERVER_TOKEN_FLAG}${token}`],
    { detached: true, stdio: 'ignore' },
  );
  children.push(child);
  return new Promise<number>((started, fail) => {
    child.once('error', fail);
    child.once('spawn', () => started(child.pid ?? 0));
  });
}

function control(over: Partial<StaleServerControl>): StaleServerControl {
  return { commandOf: () => null, killGroup: vi.fn(), isAlive: () => false, ...over };
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
    expect(isAlive(pid)).toBe(false);
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
    const killGroup = vi.fn();
    recordServer(dir, 8700, { pid: 4242, token: 't', label: 'worker-0 api' });

    const stopped = await stopStaleServers(dir, undefined, control({ killGroup }));

    expect(stopped).toEqual([]);
    expect(killGroup).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('stops only the servers on the given ports', async () => {
    const killGroup = vi.fn();
    recordServer(dir, 8700, { pid: 4242, token: 'a', label: 'worker-0 api' });
    recordServer(dir, 8710, { pid: 4343, token: 'b', label: 'worker-1 api' });
    const commandOf = (pid: number): string =>
      `node serve-worker.mts ${SERVER_TOKEN_FLAG}${pid === 4242 ? 'a' : 'b'}`;

    const stopped = await stopStaleServers(dir, [8700, 8701], control({ commandOf, killGroup }));

    expect(stopped).toEqual(['worker-0 api (pid 4242)']);
    expect(killGroup).toHaveBeenCalledExactlyOnceWith(4242);
    expect(readdirSync(dir)).toEqual(['8710.json']);
  });

  it('drops a record cut short by a kill mid-write: it names nothing to stop', async () => {
    const killGroup = vi.fn();
    writeFileSync(join(dir, '8700.json'), '{"pid": 42');
    writeFileSync(join(dir, '8701.json'), JSON.stringify({ pid: 1, token: 't', label: 'init' }));

    const stopped = await stopStaleServers(dir, undefined, control({ commandOf: () => 't', killGroup }));

    expect(stopped).toEqual([]);
    expect(killGroup).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('answers nothing when no run has left records', async () => {
    expect(await stopStaleServers(join(dir, 'never-created'))).toEqual([]);
  });

  it('throws when a server outlives its SIGKILL, so the start does not go on to a taken port', async () => {
    vi.useFakeTimers();
    try {
      recordServer(dir, 8700, { pid: 4242, token: 'a', label: 'worker-0 api' });
      const stuck = control({ commandOf: () => `${SERVER_TOKEN_FLAG}a`, isAlive: () => true });

      const outcome = expect(stopStaleServers(dir, undefined, stuck)).rejects.toThrow(/still running/);
      await vi.advanceTimersByTimeAsync(6_000);

      await outcome;
    } finally {
      vi.useRealTimers();
    }
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
