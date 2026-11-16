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

  const run = (args: string[]): void => {
    spawnSync('claude', args, {
      cwd: dir,
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: join(dir, 'home') },
      stdio: 'ignore',
      timeout: 60_000,
    });
  };

  it('starts the server without the flags (the vector is real)', () => {
    run(['-p', 'reply ok', '--settings', join(dir, 'managed.json'), '--max-turns', '1']);
    expect(existsSync(join(dir, 'MCP_RAN'))).toBe(true);
  }, 90_000);

  it('does not start it with the runner’s launch flags', () => {
    const flags = claudeLaunchArgv({
      prompt: 'reply ok',
      model: 'haiku',
      settingsPath: join(dir, 'managed.json'),
    });
    run([...flags, '--max-turns', '1']);
    expect(existsSync(join(dir, 'MCP_RAN'))).toBe(false);
  }, 90_000);
});
