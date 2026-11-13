import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * The api Worker as the e2e local stack runs it, for the runner's integration specs (architect note on #468,
 * decision 13): `ENVIRONMENT=local`, `AUTH_MODE=local`, a fresh local D1 under a temp dir. Nothing here talks to a
 * remote service or a remote D1: every wrangler call is `--local` with this stack's `--persist-to`.
 */

const WORKSPACE_ROOT = resolve(import.meta.dirname, '../../../..');
const WRANGLER = join(WORKSPACE_ROOT, 'node_modules/.bin/wrangler');
const API_CONFIG = 'apps/api/wrangler.jsonc';
const START_TIMEOUT_MS = 90_000;

export interface LocalStack {
  readonly origin: string;
  readonly dir: string;
  /** Runs one fixed SQL statement on this stack's local D1. */
  d1(sql: string): Promise<void>;
  stop(): Promise<void>;
}

async function freePort(offset: number): Promise<number> {
  const base = Number(process.env['E2E_PORT_BASE'] ?? '');
  if (Number.isInteger(base) && base > 1024) {
    // Beside the e2e stacks (three ports per worker from the base), so nothing else on the machine collides.
    return base + offset;
  }
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === 'object' && address !== null ? done(address.port) : fail(new Error('no port')),
      );
    });
  });
}

function runWrangler(args: readonly string[], logPath: string): Promise<void> {
  const log = openSync(logPath, 'a');
  return new Promise((done, fail) => {
    const child = spawn(WRANGLER, args, {
      cwd: WORKSPACE_ROOT,
      stdio: ['ignore', log, log],
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' },
    });
    child.on('error', fail);
    child.on('exit', (code) => {
      closeSync(log);
      if (code === 0) {
        done();
      } else {
        fail(
          new Error(
            `wrangler ${args.slice(0, 3).join(' ')} exited with ${String(code)}: ${readFileSync(logPath, 'utf8').slice(-2000)}`,
          ),
        );
      }
    });
  });
}

async function waitForHealth(origin: string, api: ChildProcess, logPath: string): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (api.exitCode !== null) {
      throw new Error(`the api exited during start: ${readFileSync(logPath, 'utf8').slice(-2000)}`);
    }
    try {
      const response = await fetch(`${origin}/api/v1/healthz`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        return;
      }
    } catch (error: unknown) {
      if (!(error instanceof Error)) {
        throw error;
      }
      // Not listening yet; try again below.
    }
    await new Promise<void>((done) => setTimeout(done, 250));
  }
  throw new Error(
    `the api did not answer in ${String(START_TIMEOUT_MS)} ms: ${readFileSync(logPath, 'utf8').slice(-2000)}`,
  );
}

/** `portOffset` keeps two integration files that run in parallel off each other's port. */
export async function startLocalStack(portOffset: number): Promise<LocalStack> {
  const dir = await mkdtemp(join(tmpdir(), 'tcr-int-'));
  const state = join(dir, 'state');
  const assets = join(dir, 'assets');
  await mkdir(assets);
  const logPath = join(dir, 'api.log');
  const local = [
    'team-console-dev',
    '--local',
    '--config',
    API_CONFIG,
    '--env',
    'dev',
    '--persist-to',
    state,
  ];
  await runWrangler(['d1', 'migrations', 'apply', ...local], logPath);
  const port = await freePort(portOffset);
  const origin = `http://127.0.0.1:${String(port)}`;
  const log = openSync(logPath, 'a');
  const api = spawn(
    WRANGLER,
    [
      'dev',
      '--config',
      API_CONFIG,
      '--env',
      'dev',
      '--ip',
      '127.0.0.1',
      '--port',
      String(port),
      '--inspector-port',
      '0',
      '--persist-to',
      state,
      // The console's build is not this suite's input: an empty assets directory stands in for it.
      '--assets',
      assets,
      '--show-interactive-dev-session=false',
      '--var',
      'ENVIRONMENT:local',
      '--var',
      'AUTH_MODE:local',
      '--var',
      'RUNNER_RELEASE_VERSION:0.3.0',
      '--var',
      'RUNNER_MINIMUM_VERSION:0.1.0',
    ],
    {
      cwd: WORKSPACE_ROOT,
      detached: true,
      stdio: ['ignore', log, log],
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' },
    },
  );
  closeSync(log);
  await waitForHealth(origin, api, logPath);

  return {
    origin,
    dir,
    d1: (sql) => runWrangler(['d1', 'execute', ...local, '--command', sql], logPath),
    stop: async () => {
      const pid = api.pid;
      if (pid !== undefined && api.exitCode === null) {
        const exited = new Promise<void>((done) => api.once('exit', () => done()));
        process.kill(-pid, 'SIGTERM');
        await exited;
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}
