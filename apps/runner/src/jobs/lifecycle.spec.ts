import { chmod, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { NoneBackend } from '../backends/none';
import { loadRunnerState, saveRunnerState } from '../budget/state';
import { RunnerClient } from '../client/runner-client';
import { JobRegistry } from '../proxy/job-registry';
import { JOB_ID, RUNNER_ID, fakeConsole, jobFixture, json, sentinels } from '../testing/fake-console';
import { SCENARIO, makeRunnerHome, recordingConsole, runnerConfigFor } from '../testing/job-fixture';
import { runLoop } from './loop';
import { runJob, type JobConsole, type JobRunDeps } from './run-job';

/**
 * The job loop against the `none` backend and the fake CLI (architect note on #468, PR 2): threat model C4 "job
 * outlives lease" (kill at `maxMinutes`, token dropped after finish), Ctrl-C, the usage budget, the launch refusals
 * and the sentinel on the wire and in the log.
 */

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('job lifecycle', () => {
  let fixture: Awaited<ReturnType<typeof makeRunnerHome>>;
  let logs: string[];

  beforeEach(async () => {
    fixture = await makeRunnerHome();
    logs = [];
  });

  afterEach(async () => {
    await fixture.done();
  });

  function depsFor<C extends JobConsole>(
    client: C,
    overrides: Partial<Omit<JobRunDeps, 'client'>> = {},
  ): JobRunDeps & { client: C } {
    return {
      home: fixture.home,
      config: runnerConfigFor(fixture.repo),
      client,
      backend: new NoneBackend(fixture.home),
      registry: new JobRegistry(),
      sourceEnv: {
        PATH: process.env['PATH'],
        ANTHROPIC_API_KEY: sentinels.anthropicKey,
        PT_REPO: 'geeera/team-console',
      },
      log: (line) => logs.push(line),
      now: () => new Date(),
      shutdown: new AbortController().signal,
      limitStreak: 0,
      flushMs: 20,
      ...overrides,
    };
  }

  const job = (scenario: number, maxMinutes = 5) => jobFixture({ items: [scenario], maxMinutes });

  it('runs the CLI with the built env and finishes with its metrics', async () => {
    const client = recordingConsole();
    const report = await runJob(job(SCENARIO.ok), sentinels.jobToken, depsFor(client));

    expect(report).toEqual({ result: 'finished', reason: null, limit: null });
    expect(client.sent[0]).toMatchObject({ kind: 'started', payload: { kind: 'slot-dev', backend: 'none' } });
    const envLine = client.sent.find((event) => String(event.payload['line']).startsWith('env: '));
    expect(envLine?.payload['line']).toBe(
      'env: DISABLE_AUTOUPDATER,HOME,LANG,PATH,TC_API_URL,TC_CONSOLE_URL,TC_JOB_TOKEN,TC_PROJECT,TC_RUNNER_SOCKET,TMPDIR,TZ' +
        (process.platform === 'darwin' ? ',__CF_USER_TEXT_ENCODING' : ''),
    );
    expect(client.sent.some((event) => event.payload['tool'] === 'Bash')).toBe(true);
    expect(client.finished).toEqual([
      {
        result: 'finished',
        summary: 'Done: nothing to do',
        metrics: { exitCode: 0, costUsd: 0.0123, turns: 3, durationMs: 1500 },
        acted: false,
      },
    ]);
    expect(await readdir(join(fixture.home, 'jobs'))).toEqual([]);
  });

  it('drops the job token only after finish', async () => {
    const client = recordingConsole();
    const registry = new JobRegistry();
    let heldAtFinish: unknown = 'unset';
    client.onFinish = () => {
      heldAtFinish = registry.jobOfToken(sentinels.jobToken);
    };
    await runJob(job(SCENARIO.ok), sentinels.jobToken, depsFor(client, { registry }));
    expect(heldAtFinish).toEqual({ id: JOB_ID, projectSlug: 'team-console' });
    expect(registry.jobOfToken(sentinels.jobToken)).toBeNull();
  });

  it('kills the CLI at maxMinutes and finishes it failed', async () => {
    const client = recordingConsole();
    const started = Date.now();
    const report = await runJob(
      job(SCENARIO.hang, 1),
      sentinels.jobToken,
      depsFor(client, { minuteMs: 1_500 }),
    );
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(report).toMatchObject({ result: 'failed', reason: 'max-minutes' });
    expect(client.finished[0]?.metrics).toMatchObject({ reason: 'max-minutes', signal: 'SIGTERM' });
  }, 30_000);

  it('finishes a running job failed with runner-shutdown on Ctrl-C', async () => {
    const client = recordingConsole();
    const shutdown = new AbortController();
    setTimeout(() => shutdown.abort(), 1_500);
    const report = await runJob(
      job(SCENARIO.hang),
      sentinels.jobToken,
      depsFor(client, { shutdown: shutdown.signal }),
    );
    expect(report).toMatchObject({ result: 'failed', reason: 'runner-shutdown' });
    expect(client.finished[0]?.metrics).toMatchObject({ reason: 'runner-shutdown' });
  }, 30_000);

  it('stops on a lost lease', async () => {
    const client = recordingConsole();
    const { RunnerApiError } = await import('../client/runner-client');
    client.heartbeat = async () => {
      throw new RunnerApiError(409, 'job-lease-expired', 'heartbeat: 409');
    };
    const report = await runJob(
      job(SCENARIO.hang),
      sentinels.jobToken,
      depsFor(client, { heartbeatMs: 300 }),
    );
    expect(report).toMatchObject({ result: 'failed', reason: 'lease-lost' });
  }, 30_000);

  it('heartbeats while the CLI runs', async () => {
    const client = recordingConsole();
    const shutdown = new AbortController();
    setTimeout(() => shutdown.abort(), 1_200);
    await runJob(
      job(SCENARIO.hang),
      sentinels.jobToken,
      depsFor(client, { shutdown: shutdown.signal, heartbeatMs: 200 }),
    );
    expect(client.heartbeats).toBeGreaterThanOrEqual(3);
  }, 30_000);

  it('on a usage limit: finishes failed with reason and retryAt, posts paused, and the loop stops claiming', async () => {
    const client = Object.assign(recordingConsole(), {
      claims: 0,
      claim: async () => {
        client.claims += 1;
        return {
          kind: 'job' as const,
          job: job(SCENARIO.usageLimit),
          jobToken: sentinels.jobToken,
          leaseSeconds: 300,
        };
      },
    });
    const deps = depsFor(client);
    const end = await runLoop('once', {
      ...deps,
      backend: new NoneBackend(fixture.home),
      timing: { flushMs: 20 },
    });
    expect(end).toBe('ran');
    const finish = client.finished[0];
    expect(finish).toMatchObject({
      result: 'failed',
      metrics: { reason: 'usage-limit', costUsd: 0.5, turns: 7 },
    });
    const retryAt = String(finish?.metrics['retryAt']);
    expect(Date.parse(retryAt)).toBeGreaterThan(Date.now() + 50 * 60_000);
    expect(client.sent.filter((event) => event.kind === 'paused')).toEqual([
      { level: 'warn', kind: 'paused', payload: { reason: 'usage-limit', retryAt } },
    ]);
    expect(await loadRunnerState(fixture.home)).toEqual({
      schema: 1,
      pause: { reason: 'usage-limit', until: retryAt },
      limitStreak: 1,
    });

    // A restart reads state.json and claims nothing until retryAt.
    const again = await runLoop('once', { ...deps, backend: new NoneBackend(fixture.home) });
    expect(again).toBe('paused');
    expect(client.claims).toBe(1);
    expect(logs.some((line) => line.includes(`paused (usage-limit) until ${retryAt}`))).toBe(true);
  }, 30_000);

  it('backs off a rate limit from the streak in state.json, and a success resets it', async () => {
    await saveRunnerState(fixture.home, { schema: 1, pause: null, limitStreak: 2 });
    let next = SCENARIO.rateLimit as number;
    const client = Object.assign(recordingConsole(), {
      claim: async () => ({
        kind: 'job' as const,
        job: job(next),
        jobToken: sentinels.jobToken,
        leaseSeconds: 300,
      }),
    });
    const before = Date.now();
    await runLoop('once', { ...depsFor(client), timing: { flushMs: 20 } });
    const state = await loadRunnerState(fixture.home);
    expect(state.limitStreak).toBe(3);
    const pausedFor = Date.parse(state.pause?.until ?? '') - before;
    expect(pausedFor).toBeGreaterThanOrEqual(20 * 60_000);
    expect(pausedFor).toBeLessThan(21 * 60_000);

    await saveRunnerState(fixture.home, { ...state, pause: null });
    next = SCENARIO.ok;
    await runLoop('once', { ...depsFor(client), timing: { flushMs: 20 } });
    expect(await loadRunnerState(fixture.home)).toEqual({ schema: 1, pause: null, limitStreak: 0 });
  }, 30_000);

  it('fails an unknown failure with its exit code and does not pause', async () => {
    const client = Object.assign(recordingConsole(), {
      claim: async () => ({
        kind: 'job' as const,
        job: job(SCENARIO.crash),
        jobToken: sentinels.jobToken,
        leaseSeconds: 300,
      }),
    });
    await runLoop('once', { ...depsFor(client), timing: { flushMs: 20 } });
    expect(client.finished[0]).toMatchObject({ result: 'failed', metrics: { reason: 'exit', exitCode: 3 } });
    expect(client.sent.some((event) => event.kind === 'paused')).toBe(false);
    expect(await loadRunnerState(fixture.home)).toEqual({ schema: 1, pause: null, limitStreak: 0 });
  }, 30_000);

  describe('launch refusals: failed with metrics.reason, the CLI never starts', () => {
    const marker = (): string => join(fixture.root, 'cli-started');

    async function refusedWith(
      overrides: Partial<JobRunDeps['config']>,
      jobOverrides = {},
    ): Promise<string | null> {
      const client = recordingConsole();
      // A CLI that would leave a marker if it ever ran.
      const cli = join(fixture.root, 'cli.sh');
      await writeFile(cli, `#!/bin/sh\ntouch ${marker()}\n`);
      await chmod(cli, 0o755);
      const config = {
        ...runnerConfigFor(fixture.repo),
        toolchain: { path: '/usr/bin:/bin', claude: cli },
        ...overrides,
      };
      const report = await runJob(
        { ...job(SCENARIO.ok), ...jobOverrides },
        sentinels.jobToken,
        depsFor(client, { config }),
      );
      expect(report.result).toBe('failed');
      expect(client.finished[0]?.result).toBe('failed');
      await expect(readdir(fixture.root)).resolves.not.toContain('cli-started');
      expect(
        client.sent.some((event) => event.kind === 'notice' && event.payload['refused'] === report.reason),
      ).toBe(true);
      return report.reason;
    }

    it('a credential-shaped passthrough name', async () => {
      expect(await refusedWith({ env: { passthrough: ['PT_REPO', 'ANTHROPIC_API_KEY'] } })).toBe(
        'env-passthrough-refused',
      );
    });

    it('a credential kind the backend may not use', async () => {
      expect(
        await refusedWith({ credential: { kind: 'setup-token', file: 'credentials/claude-setup-token' } }),
      ).toBe('credential-not-allowed');
    });

    it('a Claude OAuth credential on a hosted job', async () => {
      // `none` may only hold an api-key, so the pairing refusal comes first; the env-builder spec covers the rest.
      expect(
        await refusedWith(
          { credential: { kind: 'claude-config-dir', path: '/Users/x/.claude' } },
          { dispatch: 'hosted' },
        ),
      ).toBe('credential-not-allowed');
    });

    it('a poisoned mirror config', async () => {
      const first = recordingConsole();
      await runJob(job(SCENARIO.ok), sentinels.jobToken, depsFor(first));
      const { fixtureGit } = await import('../testing/job-fixture');
      fixtureGit([
        '--git-dir',
        join(fixture.home, 'work', 'team-console', 'mirror'),
        'config',
        'core.hooksPath',
        '/tmp/h',
      ]);
      expect(await refusedWith({})).toBe('git-config-refused');
    });

    it('a project without a configured repository', async () => {
      expect(await refusedWith({ repositories: {} })).toBe('repository-not-configured');
    });

    it('a role without a model', async () => {
      expect(await refusedWith({}, { role: 'designer' })).toBe('role-unknown');
    });
  });

  it('plant-then-verify: nothing a job plants reaches the next job', async () => {
    const client = recordingConsole();
    await runJob(job(SCENARIO.plant), sentinels.jobToken, depsFor(client));
    const planted = String(client.finished[0]?.summary);
    expect(planted).toMatch(/^planted pid=\d+ settings-writable=false plugin-writable=false$/);
    const pid = Number(/pid=(\d+)/.exec(planted)?.[1]);
    const deadline = Date.now() + 3_000;
    while (isAlive(pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(isAlive(pid)).toBe(false);

    const verify = recordingConsole();
    await runJob(
      jobFixture({ id: '01JC00000000000000000000J3', items: [SCENARIO.verify] }),
      sentinels.jobToken,
      depsFor(verify),
    );
    expect(verify.finished[0]).toMatchObject({ result: 'finished', summary: 'clean' });
  }, 30_000);

  it('sentinel: planted secrets never reach an event, the finish or a log line', async () => {
    const fake = fakeConsole((request) =>
      request.url.endsWith('/events')
        ? json(201, { lastSeq: 1, capped: false })
        : json(200, { leaseUntil: 'x' }),
    );
    const client = new RunnerClient({
      apiUrl: 'https://console.example',
      runnerId: RUNNER_ID,
      audience: 'team-console:dev',
      privateKey: generateKeyPairSync('ed25519').privateKey,
      fetch: fake.fetch,
    });
    await mkdir(join(fixture.home, 'credentials'), { mode: 0o700 });
    await writeFile(join(fixture.home, 'credentials', 'anthropic.key'), sentinels.anthropicKey, {
      mode: 0o600,
    });
    const config = {
      ...runnerConfigFor(fixture.repo),
      credential: { kind: 'api-key' as const, file: 'credentials/anthropic.key' },
    };
    await runJob(job(SCENARIO.sentinel), sentinels.jobToken, depsFor(client, { config }));

    const wire = fake.requests.map((request) => request.body ?? '').join('\n');
    expect(wire).toContain('[redacted:');
    expect(fake.requests.some((request) => request.url.endsWith('/finish'))).toBe(true);
    for (const secret of Object.values(sentinels)) {
      expect(wire).not.toContain(secret);
      expect(logs.join('\n')).not.toContain(secret);
    }
  }, 30_000);
});
