import type { IsolationBackend } from '../backends/backend';
import { MAX_PAUSE_MS } from '../budget/detect';
import { saveRunnerState } from '../budget/state';
import { makeRunnerHome, recordingConsole, runnerConfigFor } from '../testing/job-fixture';
import { mirroredPauseOf, runLoop, type LoopConsole, type LoopDeps } from './loop';

/**
 * The local pause mirrored to the console (#571, ADR 0008 decision 9): posted when it starts — again after a restart
 * — and cleared once it lapses; a console that cannot be reached never stops the runner, whose own pause is the
 * enforcement.
 */

const preflightOnly = { preflight: async () => undefined } as unknown as IsolationBackend;

describe('the pause mirrored to the console', () => {
  let fixture: Awaited<ReturnType<typeof makeRunnerHome>>;
  let logs: string[];

  beforeEach(async () => {
    fixture = await makeRunnerHome();
    logs = [];
  });

  afterEach(async () => {
    await fixture.done();
  });

  function depsFor(client: LoopConsole, overrides: Partial<LoopDeps> = {}): LoopDeps {
    return {
      home: fixture.home,
      config: runnerConfigFor(fixture.repo),
      client,
      backend: preflightOnly,
      sourceEnv: {},
      log: (line) => logs.push(line),
      now: () => new Date(),
      shutdown: new AbortController().signal,
      ...overrides,
    };
  }

  it('posts a pause still in force from state.json on start, and claims nothing', async () => {
    const until = new Date(Date.now() + 30 * 60_000).toISOString();
    await saveRunnerState(fixture.home, { schema: 1, pause: { reason: 'rate-limit', until }, limitStreak: 1 });
    let claims = 0;
    const client = Object.assign(recordingConsole(), {
      claim: async () => {
        claims += 1;
        return { kind: 'idle' as const, retryAfterSeconds: 60 };
      },
    });
    expect(await runLoop('once', depsFor(client))).toBe('paused');
    expect(client.pauses).toEqual([{ reason: 'rate-limit', until }]);
    expect(claims).toBe(0);
  });

  it('clears the pause on the console once it lapses, once, then claims again', async () => {
    // A fake clock the loop alone advances (through `sleep`), never the real one: a 40 ms real-time margin
    // raced the async state-file write/read under CPU load and the pause was already seen as lapsed before
    // the loop even started (#702). `now`/`sleep` make the lapse happen exactly when the loop sleeps past it,
    // independent of how long the surrounding I/O actually takes.
    let clockMs = Date.now();
    const until = new Date(clockMs + 40).toISOString();
    await saveRunnerState(fixture.home, { schema: 1, pause: { reason: 'usage-limit', until }, limitStreak: 1 });
    const shutdown = new AbortController();
    let claims = 0;
    const client = Object.assign(recordingConsole(), {
      claim: async () => {
        claims += 1;
        if (claims === 2) {
          shutdown.abort();
        }
        return { kind: 'idle' as const, retryAfterSeconds: 60 };
      },
    });
    const sleep = (ms: number): Promise<void> => {
      clockMs += Math.max(0, ms);
      return Promise.resolve();
    };
    expect(
      await runLoop('loop', depsFor(client, { shutdown: shutdown.signal, sleep, now: () => new Date(clockMs) })),
    ).toBe('shutdown');
    expect(client.pauses).toEqual([{ reason: 'usage-limit', until }, 'resume']);
    expect(claims).toBe(2);
  });

  it('keeps the local pause when the console cannot be reached, and says so in the log', async () => {
    const until = new Date(Date.now() + 30 * 60_000).toISOString();
    await saveRunnerState(fixture.home, { schema: 1, pause: { reason: 'usage-limit', until }, limitStreak: 1 });
    const client = Object.assign(recordingConsole(), {
      claim: async () => ({ kind: 'idle' as const, retryAfterSeconds: 60 }),
      pause: async () => {
        throw new Error('pause: the console answered 503');
      },
    });
    expect(await runLoop('once', depsFor(client))).toBe('paused');
    expect(logs).toContain('could not mirror the pause to the console: pause: the console answered 503');
  });

  it('posts nothing on start when no pause is in force', async () => {
    const client = Object.assign(recordingConsole(), {
      claim: async () => ({ kind: 'idle' as const, retryAfterSeconds: 60 }),
    });
    expect(await runLoop('once', depsFor(client))).toBe('idle');
    expect(client.pauses).toEqual([]);
  });

  it('keeps until inside the console’s 24 h bound, with room for clock skew', () => {
    const now = new Date('2026-11-13T12:00:00.000Z');
    const near = { reason: 'rate-limit' as const, until: '2026-11-13T12:10:00.000Z' };
    expect(mirroredPauseOf(near, now)).toEqual(near);
    const far = mirroredPauseOf({ reason: 'usage-limit', until: '2026-11-14T12:00:00.000Z' }, now);
    expect(Date.parse(far.until) - now.getTime()).toBe(MAX_PAUSE_MS - 5 * 60_000);
  });

  it('ends the loop before a claim when the auto-updater installed a release (update.policy = auto)', async () => {
    let claims = 0;
    const client = Object.assign(recordingConsole(), {
      claim: async () => {
        claims += 1;
        return { kind: 'idle' as const, retryAfterSeconds: 60 };
      },
    });
    const beforeClaim = vi.fn(async () => true);
    expect(await runLoop('loop', depsFor(client, { beforeClaim }))).toBe('updated');
    expect(beforeClaim).toHaveBeenCalledTimes(1);
    expect(claims).toBe(0);
  });

  it('claims as usual when the auto-updater has nothing to install', async () => {
    const client = Object.assign(recordingConsole(), {
      claim: async () => ({ kind: 'idle' as const, retryAfterSeconds: 60 }),
    });
    expect(await runLoop('once', depsFor(client, { beforeClaim: async () => false }))).toBe('idle');
  });
});
