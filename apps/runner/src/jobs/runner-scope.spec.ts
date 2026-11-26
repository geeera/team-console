import type { IsolationBackend } from '../backends/backend';
import { makeRunnerHome, recordingConsole, runnerConfigFor } from '../testing/job-fixture';
import { jobFixture, sentinels } from '../testing/fake-console';
import { runLoop, type LoopConsole } from './loop';
import { scopeOfClaim, scopeOfConfig, scopeOfSelf } from './runner-scope';

/**
 * #775: the runner holds itself to the scope the console answers — `GET /runner/self` at the start, the scope in every
 * claim — never to the copy `enrol` wrote, so a change on Settings › Runners applies without a restart.
 */

const preflightOnly = { preflight: async () => undefined } as unknown as IsolationBackend;

describe('the runner scope', () => {
  it('reads the enrol-time copy as selected, and lists nothing under all until the console answers', () => {
    expect(scopeOfConfig({ allowedProjects: ['team-console'] })).toEqual({
      source: 'config',
      projectScope: 'selected',
      projects: ['team-console'],
    });
    expect(scopeOfConfig({ projectScope: 'selected', allowedProjects: ['a', 'b'] })).toEqual({
      source: 'config',
      projectScope: 'selected',
      projects: ['a', 'b'],
    });
    expect(scopeOfConfig({ projectScope: 'all', allowedProjects: [] })).toEqual({
      source: 'config',
      projectScope: 'all',
      projects: [],
    });
  });

  it('takes the effective project list from the console’s self and claim answers', () => {
    expect(
      scopeOfSelf({
        runner: {
          id: 'x',
          name: 'n',
          accountId: 'a',
          projectScope: 'all',
          allowedProjects: [],
          isolation: 'user',
          version: '1',
          belowMinimum: false,
          pausedUntil: null,
          lastSeenAt: null,
        },
        projects: [
          { slug: 'team-console', accessSource: 'subscription' },
          { slug: 'storify', accessSource: 'api_key' },
        ],
      }),
    ).toEqual({ source: 'self', projectScope: 'all', projects: ['team-console', 'storify'] });
    expect(
      scopeOfClaim({ projectScope: 'selected', allowedProjects: ['storify'], projects: ['storify'] }),
    ).toEqual({
      source: 'claim',
      projectScope: 'selected',
      projects: ['storify'],
    });
  });
});

describe('the loop refreshes the scope from the console', () => {
  let fixture: Awaited<ReturnType<typeof makeRunnerHome>>;
  let logs: string[];

  beforeEach(async () => {
    fixture = await makeRunnerHome();
    logs = [];
  });

  afterEach(async () => {
    await fixture.done();
  });

  function loopWith(client: LoopConsole, config = runnerConfigFor(fixture.repo)) {
    const shutdown = new AbortController();
    return {
      shutdown,
      run: () =>
        runLoop('loop', {
          home: fixture.home,
          config,
          client,
          backend: preflightOnly,
          sourceEnv: {},
          log: (line) => logs.push(line),
          now: () => new Date(),
          shutdown: shutdown.signal,
          sleep: async () => undefined,
        }),
    };
  }

  it('declares its access sources with every claim and starts from /runner/self', async () => {
    const claims: unknown[] = [];
    const client = Object.assign(recordingConsole(), {
      self: async () => ({
        runner: {
          id: 'x',
          name: 'n',
          accountId: 'a',
          projectScope: 'all' as const,
          allowedProjects: [],
          isolation: 'none' as const,
          version: '0.1.0',
          belowMinimum: false,
          pausedUntil: null,
          lastSeenAt: null,
        },
        projects: [{ slug: 'team-console', accessSource: 'subscription' as const }],
      }),
      claim: async (input: unknown) => {
        claims.push(input);
        shutdown.abort();
        return { kind: 'idle' as const, retryAfterSeconds: 60 };
      },
    });
    const { shutdown, run } = loopWith(client);
    expect(await run()).toBe('shutdown');
    // No credential configured: the host's own sign-in serves a subscription project only.
    expect(claims).toEqual([{ accessSources: ['subscription'] }]);
    expect(logs).toContainEqual(expect.stringContaining('scope from the console: all (team-console)'));
  });

  it('refuses a job of a project the console’s latest scope no longer covers, without a restart', async () => {
    // The enrol-time copy says team-console; the console has since narrowed the runner to another project.
    const narrowed = {
      projectScope: 'selected' as const,
      allowedProjects: ['storify'],
      projects: ['storify'],
    };
    let claimed = 0;
    const client = Object.assign(recordingConsole(), {
      self: async () => {
        throw new Error('self is down');
      },
      claim: async () => {
        claimed += 1;
        if (claimed > 1) {
          shutdown.abort();
          return { kind: 'idle' as const, retryAfterSeconds: 60 };
        }
        return {
          kind: 'job' as const,
          job: jobFixture(),
          jobToken: sentinels.jobToken,
          leaseSeconds: 300,
          scope: narrowed,
        };
      },
    });
    const { shutdown, run } = loopWith(client);
    expect(await run()).toBe('shutdown');
    expect(logs).toContainEqual(expect.stringContaining('could not read the scope from the console'));
    expect(client.finished[0]).toMatchObject({
      result: 'failed',
      metrics: { reason: 'project-not-allowed' },
    });
    expect(client.finished[0]?.summary).toContain(
      'team-console is not among the projects this runner serves (claim: selected)',
    );
  });

  it('runs a job of a project the console’s scope covers even when the enrol-time copy does not', async () => {
    // Enrolled with an empty list, flipped to `all` on Settings: the console's answer wins over config.json.
    const all = { projectScope: 'all' as const, allowedProjects: [], projects: ['team-console'] };
    let claimed = 0;
    const client = Object.assign(recordingConsole(), {
      claim: async () => {
        claimed += 1;
        if (claimed > 1) {
          shutdown.abort();
          return { kind: 'idle' as const, retryAfterSeconds: 60 };
        }
        return {
          kind: 'job' as const,
          job: jobFixture(),
          jobToken: sentinels.jobToken,
          leaseSeconds: 300,
          scope: all,
        };
      },
    });
    const { shutdown, run } = loopWith(
      client,
      runnerConfigFor(fixture.repo, {
        projectScope: 'all',
        allowedProjects: [],
        toolchain: { path: '/usr/bin:/bin', claude: '/usr/bin/false' },
      }),
    );
    expect(await run()).toBe('shutdown');
    // The launch got past the scope check: whatever `claude` did next, the refusal is not the scope's.
    expect(client.finished[0]?.summary ?? '').not.toContain('project-not-allowed');
  });
});
