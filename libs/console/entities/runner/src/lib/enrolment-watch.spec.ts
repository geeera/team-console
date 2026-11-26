import { ErrorHandler } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { OWNER_ACCOUNT_ID, type EnrolmentIntentDto, type RunnerListDto } from '@shared/contracts';
import {
  EnrolmentWatch,
  INTENT_POLL_VISIBLE_MS,
  POLL_HIDDEN_MS,
  RUNNER_POLL_VISIBLE_MS,
  RUNNER_WATCH_LIMIT_MS,
} from './enrolment-watch';
import type { RunnerResult } from './runner-failure';
import {
  ENROLMENT_INTENT_FIXTURE_ID,
  RUNNER_FIXTURE_IDS,
  enrolmentIntentFixture,
  pendingIntentFixture,
  runnerFixture,
} from './runner.fixture';
import { RunnersApi } from './runners.api';

const NOW = Date.parse('2026-11-11T10:00:00.000Z');
const EXPIRES = '2026-11-11T10:10:00.000Z';
const RELEASE = { version: '0.3.0', minimumVersion: '0.2.0' };

describe('EnrolmentWatch', () => {
  let visibility: DocumentVisibilityState = 'visible';

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function setup(intents: RunnerResult<EnrolmentIntentDto>[], lists: RunnerResult<RunnerListDto>[] = []) {
    const api = {
      enrolmentIntent: vi.fn(
        async () => intents.shift() ?? { ok: true as const, value: pendingIntentFixture() },
      ),
      list: vi.fn(
        async () =>
          lists.shift() ?? {
            ok: false as const,
            failure: { kind: 'error' as const, slug: null, field: null },
          },
      ),
    };
    const errors = { handleError: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        EnrolmentWatch,
        { provide: RunnersApi, useValue: api },
        { provide: ErrorHandler, useValue: errors },
      ],
    });
    return { watch: TestBed.inject(EnrolmentWatch), api, errors };
  }

  it('reads the intent every 3 s while visible and stops once it settles', async () => {
    const { watch, api } = setup([
      { ok: true, value: pendingIntentFixture() },
      { ok: true, value: enrolmentIntentFixture() },
      { ok: true, value: enrolmentIntentFixture({ state: 'approved', runnerId: RUNNER_FIXTURE_IDS.mac }) },
    ]);
    watch.watchIntent(OWNER_ACCOUNT_ID, ENROLMENT_INTENT_FIXTURE_ID, EXPIRES);
    expect(api.enrolmentIntent).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(INTENT_POLL_VISIBLE_MS);
    expect(api.enrolmentIntent).toHaveBeenCalledWith(OWNER_ACCOUNT_ID, ENROLMENT_INTENT_FIXTURE_ID);
    expect(watch.intent()?.state).toBe('pending');
    await vi.advanceTimersByTimeAsync(INTENT_POLL_VISIBLE_MS);
    expect(watch.intent()?.state).toBe('bound');
    await vi.advanceTimersByTimeAsync(INTENT_POLL_VISIBLE_MS);
    expect(watch.intent()?.state).toBe('approved');

    await vi.advanceTimersByTimeAsync(INTENT_POLL_VISIBLE_MS * 10);
    expect(api.enrolmentIntent).toHaveBeenCalledTimes(3);
  });

  it('slows to 15 s while the page is hidden and reads at once when it is shown again', async () => {
    const { watch, api } = setup([]);
    visibility = 'hidden';
    watch.watchIntent(OWNER_ACCOUNT_ID, ENROLMENT_INTENT_FIXTURE_ID, EXPIRES);
    await vi.advanceTimersByTimeAsync(INTENT_POLL_VISIBLE_MS * 4);
    expect(api.enrolmentIntent).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(POLL_HIDDEN_MS - INTENT_POLL_VISIBLE_MS * 4);
    expect(api.enrolmentIntent).toHaveBeenCalledTimes(1);

    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(api.enrolmentIntent).toHaveBeenCalledTimes(2);
  });

  it('reads at once when the network comes back', async () => {
    const { watch, api } = setup([]);
    watch.watchIntent(OWNER_ACCOUNT_ID, ENROLMENT_INTENT_FIXTURE_ID, EXPIRES);
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(api.enrolmentIntent).toHaveBeenCalledTimes(1);
  });

  it('confirms a local expiry with one read, and the server state wins', async () => {
    const soon = new Date(NOW + 1000).toISOString();
    const { watch, api } = setup([
      { ok: true, value: pendingIntentFixture({ state: 'expired', expiresAt: soon }) },
    ]);
    watch.watchIntent(OWNER_ACCOUNT_ID, ENROLMENT_INTENT_FIXTURE_ID, soon);
    await vi.advanceTimersByTimeAsync(1600);
    expect(api.enrolmentIntent).toHaveBeenCalledTimes(1);
    expect(watch.intent()?.state).toBe('expired');
  });

  it('counts failed reads in a row and clears the count on the next answer', async () => {
    const offline = { ok: false as const, failure: { kind: 'offline' as const, slug: null, field: null } };
    const { watch } = setup([offline, offline, { ok: true, value: pendingIntentFixture() }]);
    watch.watchIntent(OWNER_ACCOUNT_ID, ENROLMENT_INTENT_FIXTURE_ID, EXPIRES);
    await vi.advanceTimersByTimeAsync(INTENT_POLL_VISIBLE_MS * 2);
    expect(watch.failedPolls()).toBe(2);
    await vi.advanceTimersByTimeAsync(INTENT_POLL_VISIBLE_MS);
    expect(watch.failedPolls()).toBe(0);
  });

  it.each(['session-expired', 'forbidden', 'not-found'] as const)('stops for good on %s', async (kind) => {
    const { watch, api } = setup([{ ok: false, failure: { kind, slug: null, field: null } }]);
    watch.watchIntent(OWNER_ACCOUNT_ID, ENROLMENT_INTENT_FIXTURE_ID, EXPIRES);
    await vi.advanceTimersByTimeAsync(INTENT_POLL_VISIBLE_MS * 5);
    expect(api.enrolmentIntent).toHaveBeenCalledTimes(1);
    expect(watch.stopped()).toBe(kind);
  });

  it('drops an answer that arrives after the watch stopped', async () => {
    let answer: (value: RunnerResult<EnrolmentIntentDto>) => void = () => undefined;
    const { watch, api } = setup([]);
    api.enrolmentIntent.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    watch.watchIntent(OWNER_ACCOUNT_ID, ENROLMENT_INTENT_FIXTURE_ID, EXPIRES);
    await vi.advanceTimersByTimeAsync(INTENT_POLL_VISIBLE_MS);
    watch.stop();
    answer({ ok: true, value: enrolmentIntentFixture() });
    await vi.advanceTimersByTimeAsync(0);
    expect(watch.intent()).toBeNull();
  });

  it('watches the new runner every 5 s until it is online, with the release minimum', async () => {
    const list = (online: boolean): RunnerResult<RunnerListDto> => ({
      ok: true,
      value: {
        runners: [runnerFixture({ online, lastSeenAt: null })],
        pendingEnrolments: [],
        release: RELEASE,
      },
    });
    const { watch, api } = setup([], [list(false), list(true)]);
    watch.watchRunner(OWNER_ACCOUNT_ID, RUNNER_FIXTURE_IDS.mac);
    await vi.advanceTimersByTimeAsync(RUNNER_POLL_VISIBLE_MS);
    expect(watch.runner()?.online).toBe(false);
    await vi.advanceTimersByTimeAsync(RUNNER_POLL_VISIBLE_MS);
    expect(watch.runner()?.online).toBe(true);
    expect(watch.minimumVersion()).toBe('0.2.0');
    await vi.advanceTimersByTimeAsync(RUNNER_POLL_VISIBLE_MS * 5);
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it('stops polling the runner after the limit and reads only on a re-check (#878)', async () => {
    const offline: RunnerResult<RunnerListDto> = {
      ok: true,
      value: {
        runners: [runnerFixture({ online: false, lastSeenAt: null })],
        pendingEnrolments: [],
        release: RELEASE,
      },
    };
    const { watch, api } = setup([]);
    api.list.mockImplementation(async () => offline);
    watch.watchRunner(OWNER_ACCOUNT_ID, RUNNER_FIXTURE_IDS.mac);
    await vi.advanceTimersByTimeAsync(RUNNER_WATCH_LIMIT_MS);
    expect(watch.gaveUp()).toBe(true);
    const reads = api.list.mock.calls.length;
    // At most 180 reads in the fifteen minutes (spec N4 rate).
    expect(reads).toBeGreaterThan(170);
    expect(reads).toBeLessThanOrEqual(RUNNER_WATCH_LIMIT_MS / RUNNER_POLL_VISIBLE_MS);

    await vi.advanceTimersByTimeAsync(RUNNER_WATCH_LIMIT_MS);
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(RUNNER_POLL_VISIBLE_MS);
    expect(api.list).toHaveBeenCalledTimes(reads);

    await watch.checkNow();
    expect(api.list).toHaveBeenCalledTimes(reads + 1);
    expect(watch.gaveUp()).toBe(true);
    await vi.advanceTimersByTimeAsync(RUNNER_POLL_VISIBLE_MS * 3);
    expect(api.list).toHaveBeenCalledTimes(reads + 1);

    api.list.mockImplementation(async () => ({
      ok: true,
      value: { runners: [runnerFixture({ online: true })], pendingEnrolments: [], release: RELEASE },
    }));
    await watch.checkNow();
    expect(watch.runner()?.online).toBe(true);
  });

  it('logs a read that throws, counts it as failed and keeps polling', async () => {
    const { watch, api, errors } = setup([]);
    const bug = new Error('guard bug');
    api.enrolmentIntent.mockImplementationOnce(async () => {
      throw bug;
    });
    watch.watchIntent(OWNER_ACCOUNT_ID, ENROLMENT_INTENT_FIXTURE_ID, EXPIRES);
    await vi.advanceTimersByTimeAsync(INTENT_POLL_VISIBLE_MS);
    expect(errors.handleError).toHaveBeenCalledWith(bug);
    expect(watch.failedPolls()).toBe(1);
    await vi.advanceTimersByTimeAsync(INTENT_POLL_VISIBLE_MS);
    expect(api.enrolmentIntent).toHaveBeenCalledTimes(2);
    expect(watch.failedPolls()).toBe(0);
  });

  it('waits out Retry-After on a 429 and says rate-limited, not unreachable (#879)', async () => {
    const limited: RunnerResult<EnrolmentIntentDto> = {
      ok: false,
      failure: { kind: 'rate-limited', slug: 'rate-limited', field: null, retryAfterSeconds: 30 },
    };
    const { watch, api } = setup([limited, limited]);
    watch.watchIntent(OWNER_ACCOUNT_ID, ENROLMENT_INTENT_FIXTURE_ID, EXPIRES);
    await vi.advanceTimersByTimeAsync(INTENT_POLL_VISIBLE_MS);
    expect(watch.rateLimitedFor()).toBe(30);
    expect(watch.failedPolls()).toBe(0);

    // Neither the 3 s timer nor a wake-up reads inside the 30 s.
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(29_000);
    expect(api.enrolmentIntent).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.enrolmentIntent).toHaveBeenCalledTimes(2);
    expect(watch.failedPolls()).toBe(0);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.enrolmentIntent).toHaveBeenCalledTimes(3);
    expect(watch.rateLimitedFor()).toBeNull();
  });

  it('waits a minute on a 429 without Retry-After', async () => {
    const { watch, api } = setup([
      { ok: false, failure: { kind: 'rate-limited', slug: null, field: null, retryAfterSeconds: null } },
    ]);
    watch.watchIntent(OWNER_ACCOUNT_ID, ENROLMENT_INTENT_FIXTURE_ID, EXPIRES);
    await vi.advanceTimersByTimeAsync(INTENT_POLL_VISIBLE_MS);
    expect(watch.rateLimitedFor()).toBe(60);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(api.enrolmentIntent).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.enrolmentIntent).toHaveBeenCalledTimes(2);
  });
});
