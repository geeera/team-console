import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { OWNER_ACCOUNT_ID, isEnrolmentCodeDto } from '@shared/contracts';
import { RunnerClient } from '../client/runner-client';
import { EXIT_OK, runCli } from '../cli/cli';
import { loadRunnerConfig } from '../config/config';
import { loadRunnerKey } from '../config/runner-key';
import { JobRegistry } from '../proxy/job-registry';
import { startJobSocket, type ProxyNotice } from '../proxy/socket-server';

/**
 * 2-B-1's integration (architect note on #468, decision 13): the api Worker as the e2e local stack runs it —
 * `ENVIRONMENT=local`, `AUTH_MODE=local`, a fresh local D1 — the owner makes a one-time code, the runner's own
 * `enrol` uses it, and the enrolled runner's JWT is accepted: `release` answers and `claim` returns 204 (no job).
 * Nothing here talks to a remote service or a remote D1.
 */

const WORKSPACE_ROOT = resolve(import.meta.dirname, '../../../..');
const WRANGLER = join(WORKSPACE_ROOT, 'node_modules/.bin/wrangler');
const API_CONFIG = 'apps/api/wrangler.jsonc';
const START_TIMEOUT_MS = 90_000;

async function freePort(): Promise<number> {
  const base = Number(process.env['E2E_PORT_BASE'] ?? '');
  if (Number.isInteger(base) && base > 1024) {
    // Beside the e2e stacks (three ports per worker from the base), so nothing else on the machine collides.
    return base + 90;
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

describe('integration: enrol against the local stack, then claim', () => {
  let dir: string;
  let origin: string;
  let api: ChildProcess | null = null;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tcr-int-'));
    const state = join(dir, 'state');
    const assets = join(dir, 'assets');
    await mkdir(assets);
    const logPath = join(dir, 'api.log');
    await runWrangler(
      [
        'd1',
        'migrations',
        'apply',
        'team-console-dev',
        '--local',
        '--config',
        API_CONFIG,
        '--env',
        'dev',
        '--persist-to',
        state,
      ],
      logPath,
    );
    const port = await freePort();
    origin = `http://127.0.0.1:${String(port)}`;
    const log = openSync(logPath, 'a');
    api = spawn(
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
  }, 150_000);

  afterAll(async () => {
    const pid = api?.pid;
    if (pid !== undefined && api?.exitCode === null) {
      const exited = new Promise<void>((done) => api?.once('exit', () => done()));
      process.kill(-pid, 'SIGTERM');
      await exited;
    }
    await rm(dir, { recursive: true, force: true });
  }, 30_000);

  it('enrols with a one-time code, then release answers and claim returns 204', async () => {
    // 1. The owner's half (Settings › Runners): a one-time code for this account, no projects yet.
    const codeResponse = await fetch(`${origin}/api/v1/accounts/${OWNER_ACCOUNT_ID}/runners/enrolment-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ name: 'Integration runner', allowedProjects: [] }),
    });
    expect(codeResponse.status).toBe(201);
    const enrolment: unknown = await codeResponse.json();
    if (!isEnrolmentCodeDto(enrolment)) {
      throw new Error('the enrolment-code answer is not an EnrolmentCodeDto');
    }

    // 2. The runner's half: the real CLI entry, the real network, a fresh TC_RUNNER_HOME.
    const home = join(dir, 'home');
    const out: string[] = [];
    const err: string[] = [];
    const exit = await runCli(
      ['enrol', '--url', enrolment.apiUrl, '--code', enrolment.code, '--backend', 'none'],
      {
        env: { TC_RUNNER_HOME: home },
        homeDir: dir,
        host: { os: process.platform, arch: process.arch, hostname: 'integration.local' },
        fetch: (url, init) => fetch(url, init),
        stdout: (line) => out.push(line),
        stderr: (line) => err.push(line),
      },
    );
    expect(err).toEqual([]);
    expect(exit).toBe(EXIT_OK);
    expect(out.join('\n')).toContain('Enrolled "Integration runner"');
    expect(out.join('\n')).not.toContain(enrolment.code);

    // 3. The same code a second time is refused: single use.
    const again = await runCli(
      ['enrol', '--url', enrolment.apiUrl, '--code', enrolment.code, '--backend', 'none'],
      {
        env: { TC_RUNNER_HOME: join(dir, 'home-2') },
        homeDir: dir,
        host: { os: process.platform, arch: process.arch, hostname: 'integration.local' },
        fetch: (url, init) => fetch(url, init),
        stdout: () => undefined,
        stderr: (line) => err.push(line),
      },
    );
    expect(again).not.toBe(EXIT_OK);
    expect(err.join('\n')).toContain('wrong, already used or expired');

    // 4. The enrolled runner talks to its door with JWTs signed by the key it just stored.
    const config = await loadRunnerConfig(home);
    expect(config).toMatchObject({
      apiUrl: origin,
      audience: 'team-console:local',
      backend: 'none',
      allowedProjects: [],
    });
    const client = new RunnerClient({
      apiUrl: config.apiUrl,
      runnerId: config.runnerId,
      audience: config.audience,
      privateKey: await loadRunnerKey(home),
    });
    await expect(client.release()).resolves.toEqual({ version: '0.3.0', minimumVersion: '0.1.0' });
    await expect(client.claim()).resolves.toEqual({ kind: 'idle', retryAfterSeconds: 60 });
    await expect(client.claim()).resolves.toMatchObject({ kind: 'idle' });

    // 5. A JWT presented twice is refused: the runner must mint one per call (single-use jti, C4 row 1).
    const jwt = client.runnerJwt();
    const first = await fetch(`${origin}/api/v1/runner/release`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const replay = await fetch(`${origin}/api/v1/runner/release`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(first.status).toBe(200);
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({ type: 'https://team-console/problems/runner-jwt-replayed' });

    // 6. A job's call through the socket reaches the console with this runner's credentials; the console then
    // judges the job token (here one it never minted: 401), and another project never leaves the runner.
    const registry = new JobRegistry();
    const jobId = '01JC00000000000000000000J1';
    const jobToken = `tcj_${'q'.repeat(43)}`;
    registry.register({ id: jobId, projectSlug: 'team-console' }, jobToken);
    const notices: ProxyNotice[] = [];
    const socketDir = await mkdtemp(join(tmpdir(), 'tcr-sock-'));
    const socket = await startJobSocket({
      socketPath: join(socketDir, 'sock', 'tc.sock'),
      job: { id: jobId, projectSlug: 'team-console' },
      registry,
      forwarder: client,
      notice: async (_jobId, notice) => {
        notices.push(notice);
      },
      onError: (error) => {
        throw error;
      },
    });
    const viaSocket = (path: string): Promise<number> =>
      new Promise((done, fail) => {
        const request = httpRequest(
          { socketPath: socket.path, path, headers: { Authorization: `Bearer ${jobToken}` } },
          (response) => {
            response.resume();
            response.on('end', () => done(response.statusCode ?? 0));
          },
        );
        request.on('error', fail);
        request.end();
      });
    try {
      expect(await viaSocket('/api/v1/projects/team-console/items')).toBe(401);
      expect(await viaSocket('/api/v1/projects/another-product/items')).toBe(403);
      expect(notices).toEqual([
        { proxy: 'refused', method: 'GET', pathClass: 'project', status: 403, reason: 'other-project' },
      ]);
    } finally {
      await socket.close();
      await rm(socketDir, { recursive: true, force: true });
    }
  }, 60_000);
});
