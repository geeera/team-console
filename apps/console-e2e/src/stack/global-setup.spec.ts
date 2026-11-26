import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearEarlierRun } from './global-setup';
import { recordServer, serverArgs, type GroupMember, type StaleServerControl } from './stale-servers';

const STARTED = 'Wed Nov 25 18:33:54 2026';
const RECORD = { pid: 4242, token: 'abc', label: 'worker-0 api', startedAt: STARTED } as const;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'global-setup-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A process table with the server of `RECORD` as the leader of its group; `killGroup` empties it. */
function table(): StaleServerControl & { killed: number[] } {
  const groups: Record<number, GroupMember[]> = {
    [RECORD.pid]: [
      { pid: RECORD.pid, argv: ['/usr/local/bin/node', ...serverArgs(RECORD.token)], startedAt: STARTED },
    ],
  };
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

describe('clearEarlierRun', () => {
  it('stops what the records of the earlier run point at, then clears its stacks', async () => {
    const stacksDir = join(root, 'tmp/console-e2e');
    const serversDir = join(stacksDir, 'servers');
    recordServer(serversDir, 8700, RECORD, root);
    mkdirSync(join(stacksDir, 'worker-0'));
    const control = table();

    const stale = await clearEarlierRun({ root, stacksDir, serversDir }, { control });

    expect(stale).toEqual(['worker-0 api (pid 4242)']);
    expect(control.killed).toEqual([4242]);
    expect(existsSync(stacksDir)).toBe(false);
  });

  it('reads and removes nothing behind a link on the way down: the old state stays as it was', async () => {
    const elsewhere = join(root, 'elsewhere');
    recordServer(join(elsewhere, 'console-e2e/servers'), 8700, RECORD, root);
    symlinkSync(elsewhere, join(root, 'tmp'));
    const stacksDir = join(root, 'tmp/console-e2e');
    const control = table();

    await expect(
      clearEarlierRun({ root, stacksDir, serversDir: join(stacksDir, 'servers') }, { control }),
    ).rejects.toThrow(/tmp is a symbolic link/);

    expect(control.killed).toEqual([]);
    expect(readdirSync(join(elsewhere, 'console-e2e/servers'))).toEqual(['8700.json']);
  });

  it('starts clean when no earlier run left anything', async () => {
    const stacksDir = join(root, 'tmp/console-e2e');

    expect(await clearEarlierRun({ root, stacksDir, serversDir: join(stacksDir, 'servers') })).toEqual([]);
    expect(existsSync(stacksDir)).toBe(false);
  });
});
