import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeLaunchArgv, EMPTY_MCP_CONFIG } from './launch-argv';

const argv = claudeLaunchArgv({ prompt: 'P', model: 'm', settingsPath: '/s.json' });

describe('claudeLaunchArgv (#639)', () => {
  it('carries the strict MCP flag with an explicit empty server list', () => {
    expect(argv).toContain('--strict-mcp-config');
    expect(argv[argv.indexOf('--mcp-config') + 1]).toBe(EMPTY_MCP_CONFIG);
    expect(JSON.parse(EMPTY_MCP_CONFIG)).toEqual({ mcpServers: {} });
  });

  it('reads user settings only, so a branch checked out mid-job brings no project settings', () => {
    expect(argv[argv.indexOf('--setting-sources') + 1]).toBe('user');
  });

  it('keeps the prompt, model and managed settings', () => {
    expect(argv.slice(0, 2)).toEqual(['-p', 'P']);
    expect(argv[argv.indexOf('--model') + 1]).toBe('m');
    expect(argv[argv.indexOf('--settings') + 1]).toBe('/s.json');
    expect(argv).not.toContain('--max-turns');
  });

  it('passes the turn limit as its own argv element after --max-turns (ADR 0009 T5)', () => {
    const limited = claudeLaunchArgv({
      prompt: 'P',
      model: 'claude-sonnet-5',
      settingsPath: '/s.json',
      maxTurns: 40,
    });
    expect(limited.slice(limited.indexOf('--max-turns'), limited.indexOf('--max-turns') + 2)).toEqual([
      '--max-turns',
      '40',
    ]);
    expect(limited.filter((arg) => arg === '--model')).toHaveLength(1);
  });

  it.each([0, -1, 1.5, Number.NaN])('refuses a turn limit of %d', (maxTurns) => {
    expect(() => claudeLaunchArgv({ prompt: 'P', model: 'm', settingsPath: '/s.json', maxTurns })).toThrow(
      RangeError,
    );
  });
});

const hasClaude = ((): boolean => {
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// Marker-file probe from #639, against the real CLI (skipped where it is not installed).
describe.skipIf(!hasClaude)('a project .mcp.json server with the real CLI (#639)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tcr-mcp-'));
    await writeFile(
      join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { p: { command: '/bin/sh', args: ['-c', 'touch MCP_RAN'] } } }),
    );
    await writeFile(join(dir, 'managed.json'), '{"disableAllHooks":true}');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A fresh HOME (never the developer's login) and no autoupdate, telemetry or other non-essential traffic (#704). */
  const run = (args: string[]): void => {
    spawnSync('claude', args, {
      cwd: dir,
      env: {
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        HOME: join(dir, 'home'),
        DISABLE_AUTOUPDATER: '1',
        DISABLE_TELEMETRY: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
      stdio: 'ignore',
      timeout: 60_000,
    });
  };
  const marker = (): string => join(dir, 'MCP_RAN');

  // One `it` (#704): the negative half only means something once the same CLI, in the same directory, was seen to
  // start the server without the flags; an early exit for an unrelated reason would otherwise pass it.
  it('starts the server without the flags and not with the runner’s launch flags', async () => {
    run(['-p', 'reply ok', '--settings', join(dir, 'managed.json'), '--max-turns', '1']);
    expect(existsSync(marker())).toBe(true);

    await rm(marker());
    const flags = claudeLaunchArgv({
      prompt: 'reply ok',
      model: 'haiku',
      settingsPath: join(dir, 'managed.json'),
    });
    run([...flags, '--max-turns', '1']);
    expect(existsSync(marker())).toBe(false);
  }, 150_000);
});
