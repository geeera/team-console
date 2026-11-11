import { TestBed } from '@angular/core/testing';
import type { JobDto, JobEventDto, JobEventListDto, JobListDto } from '@shared/contracts';
import type { JobResult } from './job-failure';
import { JOB_FIXTURE_IDS, jobEventFixture, jobFixture, queuedJobFixture } from './job.fixture';
import { JobsApi } from './jobs.api';
import { JOBS_IDLE_POLL_MS, JOBS_LIVE_POLL_MS, JobsStore } from './jobs.store';

type ListAnswer = JobResult<JobListDto>;
type EventsAnswer = JobResult<JobEventListDto>;

const ok = <T>(value: T): JobResult<T> => ({ ok: true, value });
const jobsOf = (...jobs: JobDto[]): ListAnswer => ok({ jobs, nextCursor: null });
const eventsOf = (...events: JobEventDto[]): EventsAnswer => ok({ events, nextCursor: null });

/** A JobsApi whose answers each case queues; every call is recorded. */
class FakeJobsApi {
  readonly lists: ListAnswer[] = [];
  readonly events: EventsAnswer[] = [];
  readonly listCalls: string[] = [];
  readonly eventCalls: { slug: string; jobId: string; after: number }[] = [];

  list(slug: string): Promise<ListAnswer> {
    this.listCalls.push(slug);
    return Promise.resolve(this.lists.shift() ?? jobsOf());
  }

  eventsFor(slug: string, jobId: string, after: number): Promise<EventsAnswer> {
    this.eventCalls.push({ slug, jobId, after });
    return Promise.resolve(this.events.shift() ?? eventsOf());
  }
}

describe('JobsStore', () => {
  let api: FakeJobsApi;
  let visibility: ReturnType<typeof vi.spyOn>;

  function setup(): JobsStore {
    api = new FakeJobsApi();
    TestBed.configureTestingModule({
      providers: [
        JobsStore,
        {
          provide: JobsApi,
          useValue: {
            list: (slug: string) => api.list(slug),
            events: (slug: string, jobId: string, after: number) => api.eventsFor(slug, jobId, after),
          },
        },
      ],
    });
    return TestBed.inject(JobsStore);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  });

  afterEach(() => {
    visibility.mockRestore();
    vi.useRealTimers();
  });

  it('reads the jobs, then the events of the held ones only', async () => {
    const store = setup();
    api.lists.push(jobsOf(jobFixture(), queuedJobFixture({ id: JOB_FIXTURE_IDS.second })));
    api.events.push(eventsOf(jobEventFixture(1), jobEventFixture(2)));
    const stop = store.watch('team-console');
    expect(store.status()).toBe('loading');
    await vi.advanceTimersByTimeAsync(0);

    expect(store.status()).toBe('ready');
    expect(store.current().map((job) => job.state)).toEqual(['running', 'queued']);
    expect(api.eventCalls).toEqual([{ slug: 'team-console', jobId: JOB_FIXTURE_IDS.first, after: 0 }]);
    expect(store.eventsOf(JOB_FIXTURE_IDS.first).map((event) => event.seq)).toEqual([1, 2]);
    expect(store.tile().state).toBe('running');
    stop();
  });

  it('carries the events cursor on from the last event seen', async () => {
    const store = setup();
    api.lists.push(jobsOf(jobFixture()), jobsOf(jobFixture()));
    api.events.push(eventsOf(jobEventFixture(1), jobEventFixture(2)), eventsOf(jobEventFixture(3)));
    const stop = store.watch('team-console');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(JOBS_LIVE_POLL_MS);

    expect(api.eventCalls.map((call) => call.after)).toEqual([0, 2]);
    expect(store.eventsOf(JOB_FIXTURE_IDS.first).map((event) => event.seq)).toEqual([1, 2, 3]);
    stop();
  });

  it('polls every 10 s with a live job, every minute without, and not at all while hidden', async () => {
    const store = setup();
    api.lists.push(jobsOf(queuedJobFixture()));
    const stop = store.watch('team-console');
    await vi.advanceTimersByTimeAsync(0);
    expect(api.listCalls).toHaveLength(1);

    // Live: the next read after 10 s. That one answers nothing live, so the one after waits a minute.
    await vi.advanceTimersByTimeAsync(JOBS_LIVE_POLL_MS);
    expect(api.listCalls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(JOBS_IDLE_POLL_MS - 1);
    expect(api.listCalls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.listCalls).toHaveLength(3);

    visibility.mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(JOBS_IDLE_POLL_MS * 3);
    expect(api.listCalls).toHaveLength(3);

    // Back in front: read at once, then the timer resumes.
    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(api.listCalls).toHaveLength(4);

    stop();
    await vi.advanceTimersByTimeAsync(JOBS_IDLE_POLL_MS * 3);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(api.listCalls).toHaveLength(4);
    expect(store.status()).toBe('ready');
  });

  it('starts no second refresh when visibility changes twice while one is in flight', async () => {
    const store = setup();
    const pending: ((answer: ListAnswer) => void)[] = [];
    api.list = (slug: string) => {
      api.listCalls.push(slug);
      return new Promise<ListAnswer>((resolve) => pending.push(resolve));
    };
    const stop = store.watch('team-console');
    pending[0]?.(jobsOf(jobFixture()));
    await vi.advanceTimersByTimeAsync(0);
    expect(api.listCalls).toHaveLength(1);

    // First flip starts a refresh and its list read is still pending; a second flip right behind it
    // (an alt-tab bounce fires visibilitychange twice) must not start a second one.
    document.dispatchEvent(new Event('visibilitychange'));
    expect(api.listCalls).toHaveLength(2);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(api.listCalls).toHaveLength(2);

    pending[1]?.(jobsOf(jobFixture()));
    await vi.advanceTimersByTimeAsync(0);
    expect(api.listCalls).toHaveLength(2);

    // Once that refresh has settled, a later flip is free to start its own.
    document.dispatchEvent(new Event('visibilitychange'));
    expect(api.listCalls).toHaveLength(3);
    pending[2]?.(jobsOf(jobFixture()));
    await vi.advanceTimersByTimeAsync(0);

    stop();
  });

  it('is forbidden on a 403 and error on any other first failure', async () => {
    const store = setup();
    api.lists.push({ ok: false, failure: { kind: 'forbidden', slug: 'owner-only' } });
    let stop = store.watch('team-console');
    await vi.advanceTimersByTimeAsync(0);
    expect(store.status()).toBe('forbidden');
    stop();

    api.lists.push({ ok: false, failure: { kind: 'not-found', slug: 'project-not-found' } });
    stop = store.watch('team-console');
    await vi.advanceTimersByTimeAsync(0);
    expect(store.status()).toBe('error');
    expect(store.failure()).toEqual({ kind: 'not-found', slug: 'project-not-found' });
    stop();
  });

  it('keeps the jobs shown when a later refresh fails, and says so', async () => {
    const store = setup();
    api.lists.push(jobsOf(queuedJobFixture()), { ok: false, failure: { kind: 'offline', slug: null } });
    const stop = store.watch('team-console');
    await vi.advanceTimersByTimeAsync(0);
    await store.refresh();
    expect(store.status()).toBe('ready');
    expect(store.jobs()).toHaveLength(1);
    expect(store.failure()?.kind).toBe('offline');
    stop();
  });

  it('marks a job whose events read failed and keeps its earlier events', async () => {
    const store = setup();
    api.lists.push(jobsOf(jobFixture()), jobsOf(jobFixture()));
    api.events.push(eventsOf(jobEventFixture(1)), { ok: false, failure: { kind: 'timeout', slug: null } });
    const stop = store.watch('team-console');
    await vi.advanceTimersByTimeAsync(0);
    await store.refresh();
    expect(store.eventFailures().has(JOB_FIXTURE_IDS.first)).toBe(true);
    expect(store.eventsOf(JOB_FIXTURE_IDS.first).map((event) => event.seq)).toEqual([1]);
    stop();
  });

  it('shows a job Run now queued at once, only for the project it watches', async () => {
    const store = setup();
    const stop = store.watch('team-console');
    await vi.advanceTimersByTimeAsync(0);
    store.add(queuedJobFixture({ projectSlug: 'storify' }));
    expect(store.jobs()).toHaveLength(0);
    store.add(queuedJobFixture());
    expect(store.current().map((job) => job.id)).toEqual([JOB_FIXTURE_IDS.first]);
    expect(store.tile().state).toBe('queued');
    stop();
  });

  it('drops an answer for the project it stopped watching', async () => {
    const store = setup();
    const pending: ((answer: ListAnswer) => void)[] = [];
    api.list = (slug: string) => {
      api.listCalls.push(slug);
      return new Promise<ListAnswer>((resolve) => pending.push(resolve));
    };
    const stop = store.watch('team-console');
    stop();
    const next = store.watch('storify');
    pending[0]?.(jobsOf(jobFixture()));
    await vi.advanceTimersByTimeAsync(0);
    expect(api.listCalls).toEqual(['team-console', 'storify']);
    expect(store.slug()).toBe('storify');
    expect(store.status()).toBe('loading');
    expect(store.jobs()).toEqual([]);
    next();
  });
});
