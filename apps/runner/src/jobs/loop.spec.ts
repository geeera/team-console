import { generateKeyPairSync } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IsolationBackend } from '../backends/backend';
import { createPrivateSandbox } from '../backends/sandbox';
import { RunnerClient } from '../client/runner-client';
import type { RunnerConfig } from '../config/config';
import { removeTree } from '../git/workspace';
import { CHECK_ID, RUNNER_ID, fakeConsole, json, problem, sentinels } from '../testing/fake-console';
import { makeRunnerHome, recordingConsole, runnerConfigFor } from '../testing/job-fixture';
import { runLoop } from './loop';

/** #592 item 4: the loop's own log lines pass the redactor, as the job's do. */

const preflightOnly = { preflight: async () => undefined } as unknown as IsolationBackend;

describe('the job loop log', () => {
  let fixture: Awaited<ReturnType<typeof makeRunnerHome>>;

  beforeEach(async () => {
    fixture = await makeRunnerHome();
  });

  afterEach(async () => {
    await fixture.done();
  });

  it('redacts a secret quoted in a claim error', async () => {
    const logs: string[] = [];
    const shutdown = new AbortController();
    const client = Object.assign(recordingConsole(), {
      claim: async () => {
        shutdown.abort();
        throw new Error(`claim: 401 bad bearer ${sentinels.githubToken} / ${sentinels.anthropicKey}`);
      },
    });
    const end = await runLoop('loop', {
      home: fixture.home,
      config: runnerConfigFor(fixture.repo),
      client,
      backend: preflightOnly,
      sourceEnv: {},
      log: (line) => logs.push(line),
      now: () => new Date(),
      shutdown: shutdown.signal,
      sleep: async () => undefined,
    });

    expect(end).toBe('shutdown');
    const claimLine = logs.find((line) => line.startsWith('claim failed: '));
    expect(claimLine).toContain('[redacted:');
    expect(claimLine).not.toContain(sentinels.githubToken);
    expect(claimLine).not.toContain(sentinels.anthropicKey);
  });
});

/** #1059 (security test 7): the declaration on every claim, a hostile check answer, a finish the console refuses. */
describe('the loop and runner checks', () => {
  let fixture: Awaited<ReturnType<typeof makeRunnerHome>>;
  let logs: string[];
  let calls: string[];

  beforeEach(async () => {
    fixture = await makeRunnerHome();
    logs = [];
    calls = [];
    await mkdir(join(fixture.home, 'credentials'), { mode: 0o700 });
    await writeFile(join(fixture.home, 'credentials', 'anthropic.key'), `${sentinels.anthropicKey}\n`, {
      mode: 0o600,
    });
  });

  afterEach(async () => {
    await fixture.done();
  });

  /** Records every backend call; a check's CLI prints a version and exits 0. */
  const recordingBackend = (): IsolationBackend => ({
    kind: 'none',
    preflight: async () => {
      calls.push('preflight');
    },
    prepare: async (job) => {
      calls.push(`prepare ${job.jobId}`);
      return await createPrivateSandbox(fixture.home, job);
    },
    launch: async () => {
      throw new Error('no job in these specs');
    },
    launchCheck: async () => {
      calls.push('launchCheck');
      const stdout = new PassThrough();
      stdout.end('2.1.3 (Claude Code)\n');
      return { pid: 1, stdout, exited: Promise.resolve({ exitCode: 0, signal: null }) };
    },
    kill: async () => {
      calls.push('kill');
    },
    cleanup: async (sandbox) => {
      calls.push(`cleanup ${sandbox.jobId}`);
      await removeTree(sandbox.root);
    },
  });

  const config = (): RunnerConfig =>
    runnerConfigFor(fixture.repo, { credential: { kind: 'api-key', file: 'credentials/anthropic.key' } });

  function consoleClient(answers: (() => Response)[], shutdown: AbortController) {
    const { privateKey } = generateKeyPairSync('ed25519');
    let claims = 0;
    const fake = fakeConsole((request) => {
      if (request.url.endsWith('/api/v1/runner/jobs/claim')) {
        const answer = answers[claims] ?? (() => new Response(null, { status: 204 }));
        claims += 1;
        if (claims >= answers.length) {
          shutdown.abort();
        }
        return answer();
      }
      if (request.url.includes('/api/v1/runner/checks/')) {
        return problem(404, 'runner-check-not-found');
      }
      return json(200, {});
    });
    const client = new RunnerClient({
      apiUrl: 'https://console.example',
      runnerId: RUNNER_ID,
      audience: 'team-console:dev',
      privateKey,
      fetch: fake.fetch,
    });
    return { client, requests: fake.requests };
  }

  const loopDeps = (client: RunnerClient, shutdown: AbortController, sleeps: number[]) => ({
    home: fixture.home,
    config: config(),
    client,
    backend: recordingBackend(),
    sourceEnv: {},
    log: (line: string) => logs.push(line),
    now: () => new Date(),
    shutdown: shutdown.signal,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  });

  it('declares checks on every claim, runs the check it is given, and a finish 404 is logged once, never retried', async () => {
    const shutdown = new AbortController();
    const check = { id: CHECK_ID, kind: 'smoke', deadlineSeconds: 30 };
    const { client, requests } = consoleClient(
      [
        () => json(200, { check }),
        () => new Response(null, { status: 204, headers: { 'Retry-After': '10' } }),
      ],
      shutdown,
    );
    const sleeps: number[] = [];
    expect(await runLoop('loop', loopDeps(client, shutdown, sleeps))).toBe('shutdown');

    const claims = requests.filter((request) => request.url.endsWith('/jobs/claim'));
    expect(claims).toHaveLength(2);
    for (const claim of claims) {
      expect(JSON.parse(claim.body ?? '')).toEqual({ accessSources: ['api_key'], checks: ['smoke'] });
    }
    const finishes = requests.filter((request) => request.url.includes('/runner/checks/'));
    expect(finishes.map((request) => [request.url, JSON.parse(request.body ?? '')])).toEqual([
      [
        `https://console.example/api/v1/runner/checks/${CHECK_ID}/finish`,
        { result: 'passed', claudeVersion: '2.1.3', durationMs: expect.any(Number) },
      ],
    ]);
    expect(logs.filter((line) => line.includes('did not take the report'))).toHaveLength(1);
    expect(logs.some((line) => /^check \S+ smoke: passed \(claude 2\.1\.3, \d+ ms\)$/.test(line))).toBe(true);
    expect(calls).toEqual([
      'preflight',
      'preflight',
      `prepare ${CHECK_ID}`,
      'launchCheck',
      `cleanup ${CHECK_ID}`,
      'preflight',
    ]);
    // The check's own report went out once; the next poll waited only what the console said.
    expect(sleeps).toEqual([10_000]);
    expect(JSON.stringify({ logs, requests })).not.toContain(sentinels.anthropicKey);
  });

  it.each([
    [
      'extra command/argv/env/path keys',
      { command: '/bin/sh', argv: ['-c', 'id'], env: { A: '1' }, path: '/x' },
    ],
    ['an unknown kind', { kind: 'exec' }],
    ['a path-shaped id', { id: '../../x' }],
    ['deadlineSeconds 3600', { deadlineSeconds: 3600 }],
  ])(
    'a check answer with %s is an unexpected answer: nothing prepared or launched, logged, then sleep',
    async (_what, hostile) => {
      const shutdown = new AbortController();
      const check = { id: CHECK_ID, kind: 'smoke', deadlineSeconds: 30, ...hostile };
      const { client, requests } = consoleClient([() => json(200, { check })], shutdown);
      const sleeps: number[] = [];
      expect(await runLoop('loop', loopDeps(client, shutdown, sleeps))).toBe('shutdown');

      expect(calls).toEqual(['preflight']);
      expect(logs).toContain('claim failed: claim: unexpected answer');
      expect(sleeps).toEqual([60_000]);
      expect(requests.filter((request) => request.url.includes('/runner/checks/'))).toEqual([]);
    },
  );
});
