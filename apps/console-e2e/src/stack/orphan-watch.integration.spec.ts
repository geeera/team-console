import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { groupOf } from './process-group';
import { isAlive } from './process-signal';

/**
 * The orphan watch and the orphan's stop with real processes (#999): `orphan-watch.spec.ts` covers the logic on fake
 * timers; here a starter is really killed and a process group really dies. Nothing waits a fixed time — each step
 * waits for a line of output, an exit, or a closed pipe.
 */
const FIXTURES = join(__dirname, 'testing');
const children: ChildProcess[] = [];

function start(script: string, args: readonly string[], detached: boolean): ChildProcess {
  const child = spawn(process.execPath, ['--experimental-strip-types', join(FIXTURES, script), ...args], {
    detached,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  return child;
}

/** What the processes behind `child`'s stdout and stderr write, as it arrives. */
function outputOf(child: ChildProcess): { readonly stdout: () => string; readonly stderr: () => string } {
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  return { stdout: () => stdout, stderr: () => stderr };
}

/** The number a fixture printed as `<name>=<number>`, once it has. */
async function printed(output: () => string, name: string): Promise<number> {
  const pattern = new RegExp(`${name}=(\\d+)`);
  await vi.waitFor(() => expect(output()).toMatch(pattern), { timeout: 15_000, interval: 20 });
  return Number(pattern.exec(output())?.[1]);
}

/** How `child` ended, once its output has been read to the last byte. Ask before the child can end. */
async function end(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const [code, signal] = (await once(child, 'close')) as [number | null, NodeJS.Signals | null];
  return { code, signal };
}

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }
});

describe('a server whose starter is killed (STACK_PARENT_PID)', () => {
  it('stops by itself when the starter dies while it watches', async () => {
    const starter = start('orphan-starter.mts', [], false);
    const output = outputOf(starter);
    const starterPid = await printed(output.stdout, 'starter pid');

    starter.stdin?.write('watch\n');
    expect(await printed(output.stdout, 'server watching starter')).toBe(starterPid);
    starter.kill('SIGKILL');
    // The pipe closes only when the server, which inherited it, is gone too.
    await once(starter, 'close');

    expect(starter.signalCode).toBe('SIGKILL');
    expect(output.stdout()).toContain('server orphaned');
  });

  it('stops by itself when the starter was already dead before the watch began, its parent pid already another', async () => {
    const starter = start('orphan-starter.mts', [], false);
    const output = outputOf(starter);
    const starterPid = await printed(output.stdout, 'starter pid');

    // Node closes the stdin it holds for a child when that child has exited; the server begins its watch at that end.
    starter.kill('SIGKILL');
    await once(starter, 'close');

    // Read from `process.ppid` at that moment the watch would have taken the new parent for its own (#993).
    expect(await printed(output.stdout, 'server watching starter')).toBe(starterPid);
    expect(await printed(output.stdout, 'ppid')).not.toBe(starterPid);
    expect(output.stdout()).toContain('server orphaned');
  });
});

describe('stopOrphaned', () => {
  it('kills its own process group, the fork included, when the stop does not settle in time', async () => {
    const server = start('orphaned-server.mts', ['hangs'], true);
    const output = outputOf(server);
    const ended = end(server);
    const forkPid = await printed(output.stdout, 'fork pid');

    const { code, signal } = await ended;

    expect({ code, signal }).toEqual({ code: null, signal: 'SIGKILL' });
    expect(output.stderr()).toContain('Miniflare did not stop within 200 ms');
    await vi.waitFor(() => expect(groupOf(server.pid ?? 0)).toEqual([]), { timeout: 5_000, interval: 20 });
    expect(isAlive(forkPid)).toBe(false);
  });

  it('exits 1 without killing anything when the stop settles', async () => {
    const server = start('orphaned-server.mts', ['stops'], true);
    const output = outputOf(server);
    const ended = end(server);

    const { code, signal } = await ended;

    expect({ code, signal }).toEqual({ code: 1, signal: null });
    expect(output.stderr()).toContain('the process that started this server is gone; stopping');
    expect(output.stderr()).not.toContain('did not stop within');
  });

  it('exits 1 and says why when the stop fails', async () => {
    const server = start('orphaned-server.mts', ['fails'], true);
    const output = outputOf(server);
    const ended = end(server);
    const forkPid = await printed(output.stdout, 'fork pid');

    const { code, signal } = await ended;

    expect({ code, signal }).toEqual({ code: 1, signal: null });
    expect(output.stderr()).toContain('workerd refused');
    // Nothing killed the group: the fork is still there, and is this test's to stop.
    expect(isAlive(forkPid)).toBe(true);
    process.kill(forkPid, 'SIGKILL');
  });
});
