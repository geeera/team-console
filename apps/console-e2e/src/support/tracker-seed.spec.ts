import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface SpawnCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
}

const spawned = vi.hoisted(() => ({ calls: [] as SpawnCall[], exitCode: 0 }));

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: (command: string, args: readonly string[], options: { env: Record<string, string> }) => {
    spawned.calls.push({ command, args, env: options.env });
    const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
    setImmediate(() => {
      child.stderr.emit('data', Buffer.from('no such table'));
      child.emit('exit', spawned.exitCode);
    });
    return child;
  },
}));

import { STACKS_DIR } from '../stack/local-stack';
import { localD1 } from './tracker-seed';

/** What a developer's shell holds; the values are made up per run. */
const HOST_SECRETS = [
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'GITHUB_TOKEN',
  'NODE_AUTH_TOKEN',
] as const;

describe('localD1', () => {
  beforeEach(() => {
    spawned.calls.length = 0;
    spawned.exitCode = 0;
    for (const name of HOST_SECRETS) {
      vi.stubEnv(name, randomBytes(16).toString('hex'));
    }
    vi.stubEnv('NODE_OPTIONS', '--inspect=0.0.0.0:9229');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('runs wrangler on the local D1 with the environment of the stack: no host token, no host home', async () => {
    const hostHome = process.env['HOME'];

    await localD1(0, 'SELECT 1');

    const [call] = spawned.calls;
    expect(spawned.calls).toHaveLength(1);
    expect(call?.args).toEqual(expect.arrayContaining(['d1', 'execute', '--local', '--command', 'SELECT 1']));
    expect(call?.args).not.toContain('--remote');
    const env = call?.env ?? {};
    for (const name of [...HOST_SECRETS, 'NODE_OPTIONS']) {
      expect(env).not.toHaveProperty(name);
      expect(Object.values(env)).not.toContain(process.env[name]);
    }
    expect(env['HOME']).toBe(`${STACKS_DIR}/home`);
    expect(env['HOME']).not.toBe(hostHome);
    expect(env['XDG_CONFIG_HOME']).toBe(`${STACKS_DIR}/home/.config`);
    expect(env['WRANGLER_SEND_METRICS']).toBe('false');
  });

  it('fails with what wrangler printed when the command does not exit cleanly', async () => {
    spawned.exitCode = 1;

    await expect(localD1(0, 'SELECT 1')).rejects.toThrow(/wrangler d1 execute: 1 no such table/);
  });
});
