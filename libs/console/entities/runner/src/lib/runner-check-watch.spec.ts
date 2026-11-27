import { ErrorHandler } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { OWNER_ACCOUNT_ID } from '@shared/contracts';
import { POLL_HIDDEN_MS } from './enrolment-watch';
import { CHECK_POLL_VISIBLE_MS, CHECK_WATCH_LIMIT_MS, RunnerCheckWatch } from './runner-check-watch';
import type { RunnerCheck } from './runner-check.model';
import type { RunnerResult } from './runner-failure';
import { RUNNER_CHECK_FIXTURE_ID, RUNNER_FIXTURE_IDS, runnerCheckFixture } from './runner.fixture';
import { RunnersApi } from './runners.api';

const RUNNER = RUNNER_FIXTURE_IDS.mac;
const queued = (): RunnerResult<RunnerCheck> => ({ ok: true, value: runnerCheckFixture() });
const failure = (kind: string, extra: Record<string, unknown> = {}) =>
  ({ ok: false, failure: { kind, slug: null, field: null, ...extra } }) as RunnerResult<never>;

// #1059 PR 3 (security note «Tests required → PR 3» item 3): the watch's stops and its timers.
describe('RunnerCheckWatch', () => {
  let visibility: DocumentVisibilityState = 'visible';

  beforeEach(() => {
    vi.useFakeTimers({ now: Date.parse('2026-11-27T10:00:00.000Z') });
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function setup(reads: RunnerResult<RunnerCheck>[] = []) {
    const api = { check: vi.fn(async () => reads.shift() ?? queued()) };
    TestBed.configureTestingModule({
      providers: [
        RunnerCheckWatch,
        { provide: RunnersApi, useValue: api },
        { provide: ErrorHandler, useValue: { handleError: vi.fn() } },
      ],
    });
    return { watch: TestBed.inject(RunnerCheckWatch), api };
  }

  it('reads the check by account, runner and id every 2 s and stops at a final state', async () => {
    const passed = runnerCheckFixture({ state: 'passed', claudeVersion: '2.1.4' });
    const { watch, api } = setup([
      { ok: true, value: runnerCheckFixture({ state: 'running' }) },
      { ok: true, value: passed },
    ]);
    watch.watch(OWNER_ACCOUNT_ID, RUNNER, runnerCheckFixture());
    expect(watch.check()?.state).toBe('queued');
    await vi.advanceTimersByTimeAsync(CHECK_POLL_VISIBLE_MS);
    expect(api.check).toHaveBeenCalledWith(OWNER_ACCOUNT_ID, RUNNER, RUNNER_CHECK_FIXTURE_ID);
    expect(watch.check()?.state).toBe('running');
    await vi.advanceTimersByTimeAsync(CHECK_POLL_VISIBLE_MS);
    expect(watch.check()).toEqual(passed);

    await vi.advanceTimersByTimeAsync(CHECK_POLL_VISIBLE_MS * 20);
    expect(api.check).toHaveBeenCalledTimes(2);
    expect(watch.gaveUp()).toBe(false);
  });

  it('stops at a failure too, and does not read a check the start already answered as final', async () => {
    const { watch, api } = setup([
      { ok: true, value: runnerCheckFixture({ state: 'failed', reason: 'not-picked-up' }) },
    ]);
    watch.watch(OWNER_ACCOUNT_ID, RUNNER, runnerCheckFixture());
    await vi.advanceTimersByTimeAsync(CHECK_POLL_VISIBLE_MS * 10);
    expect(api.check).toHaveBeenCalledTimes(1);
    expect(watch.check()?.reason).toBe('not-picked-up');

    watch.watch(OWNER_ACCOUNT_ID, RUNNER, runnerCheckFixture({ state: 'failed', reason: 'timeout' }));
    await vi.advanceTimersByTimeAsync(CHECK_POLL_VISIBLE_MS * 10);
    expect(api.check).toHaveBeenCalledTimes(1);
    expect(watch.check()?.reason).toBe('timeout');
  });

  it('stops reading 4 minutes after the start without a final state, and a new start re-attaches', async () => {
    const { watch, api } = setup();
    watch.watch(OWNER_ACCOUNT_ID, RUNNER, runnerCheckFixture());
    await vi.advanceTimersByTimeAsync(CHECK_WATCH_LIMIT_MS);
    expect(watch.gaveUp()).toBe(true);
    const reads = api.check.mock.calls.length;
    expect(reads).toBeLessThanOrEqual(CHECK_WATCH_LIMIT_MS / CHECK_POLL_VISIBLE_MS);
    await vi.advanceTimersByTimeAsync(CHECK_POLL_VISIBLE_MS * 10);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(api.check).toHaveBeenCalledTimes(reads);

    watch.watch(OWNER_ACCOUNT_ID, RUNNER, runnerCheckFixture({ state: 'running' }));
    expect(watch.gaveUp()).toBe(false);
    await vi.advanceTimersByTimeAsync(CHECK_POLL_VISIBLE_MS);
    expect(api.check).toHaveBeenCalledTimes(reads + 1);
  });

  it('honours a 429 Retry-After without ending the watch (N9)', async () => {
    const { watch, api } = setup([failure('rate-limited', { retryAfterSeconds: 20 })]);
    watch.watch(OWNER_ACCOUNT_ID, RUNNER, runnerCheckFixture());
    await vi.advanceTimersByTimeAsync(CHECK_POLL_VISIBLE_MS);
    expect(watch.rateLimitedFor()).toBe(20);
    expect(watch.failedPolls()).toBe(0);
    expect(watch.stopped()).toBeNull();
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(20_000 - 1);
    expect(api.check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.check).toHaveBeenCalledTimes(2);
    expect(watch.rateLimitedFor()).toBeNull();
  });

  it('waits a minute after a 429 that names no Retry-After', async () => {
    const { watch, api } = setup([failure('rate-limited', { retryAfterSeconds: null })]);
    watch.watch(OWNER_ACCOUNT_ID, RUNNER, runnerCheckFixture());
    await vi.advanceTimersByTimeAsync(CHECK_POLL_VISIBLE_MS);
    expect(watch.rateLimitedFor()).toBe(60);
    await vi.advanceTimersByTimeAsync(60_000 - 1);
    expect(api.check).toHaveBeenCalledTimes(1);
  });

  it('slows to 15 s while the page is hidden and reads at once when it is shown again', async () => {
    const { watch, api } = setup();
    visibility = 'hidden';
    watch.watch(OWNER_ACCOUNT_ID, RUNNER, runnerCheckFixture());
    await vi.advanceTimersByTimeAsync(POLL_HIDDEN_MS - 1);
    expect(api.check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(api.check).toHaveBeenCalledTimes(1);
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(api.check).toHaveBeenCalledTimes(2);
  });

  it.each(['session-expired', 'forbidden', 'not-found'] as const)('ends the watch on %s', async (kind) => {
    const { watch, api } = setup([failure(kind)]);
    watch.watch(OWNER_ACCOUNT_ID, RUNNER, runnerCheckFixture());
    await vi.advanceTimersByTimeAsync(CHECK_POLL_VISIBLE_MS * 5);
    expect(watch.stopped()).toBe(kind);
    expect(api.check).toHaveBeenCalledTimes(1);
  });

  it('counts failed reads in a row and goes on polling', async () => {
    const { watch } = setup([failure('offline'), failure('error'), queued()]);
    watch.watch(OWNER_ACCOUNT_ID, RUNNER, runnerCheckFixture());
    await vi.advanceTimersByTimeAsync(CHECK_POLL_VISIBLE_MS * 2);
    expect(watch.failedPolls()).toBe(2);
    await vi.advanceTimersByTimeAsync(CHECK_POLL_VISIBLE_MS);
    expect(watch.failedPolls()).toBe(0);
  });

  it('stops every timer when its injector is destroyed (the sheet closed)', async () => {
    const { watch, api } = setup();
    watch.watch(OWNER_ACCOUNT_ID, RUNNER, runnerCheckFixture());
    TestBed.resetTestingModule();
    await vi.advanceTimersByTimeAsync(CHECK_POLL_VISIBLE_MS * 5);
    expect(api.check).not.toHaveBeenCalled();
  });
});
