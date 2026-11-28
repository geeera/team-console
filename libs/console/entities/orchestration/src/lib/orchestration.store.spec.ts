import { TestBed } from '@angular/core/testing';
import { IDLE_POLL_MS, LIVE_POLL_MS } from '@console/shared/utils';
import type { OrchestrationDto } from '@shared/contracts';
import { OrchestrationApi } from './orchestration.api';
import type { OrchestrationResult } from './orchestration-failure';
import { idleOrchestrationFixture, runningOrchestrationFixture } from './orchestration.fixture';
import { OrchestrationStore } from './orchestration.store';

type Answer = OrchestrationResult<OrchestrationDto>;

const ok = (value: OrchestrationDto): Answer => ({ ok: true, value });
const offline: Answer = { ok: false, failure: { kind: 'offline', slug: null } };

describe('OrchestrationStore', () => {
  let answers: Answer[];
  let calls: string[];
  let visibility: ReturnType<typeof vi.spyOn>;

  function setup(): OrchestrationStore {
    answers = [];
    calls = [];
    TestBed.configureTestingModule({
      providers: [
        OrchestrationStore,
        {
          provide: OrchestrationApi,
          useValue: {
            get: (slug: string): Promise<Answer> => {
              calls.push(slug);
              return Promise.resolve(answers.shift() ?? ok(idleOrchestrationFixture()));
            },
          },
        },
      ],
    });
    return TestBed.inject(OrchestrationStore);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  });

  afterEach(() => {
    visibility.mockRestore();
    vi.useRealTimers();
  });

  it('reads the run at once and is ready with it', async () => {
    const store = setup();
    answers.push(ok(runningOrchestrationFixture()));
    const stop = store.watch('team-console');
    expect(store.status()).toBe('loading');
    await vi.advanceTimersByTimeAsync(0);

    expect(store.status()).toBe('ready');
    expect(store.run()).toEqual(runningOrchestrationFixture());
    expect(store.isActive()).toBe(true);
    expect(calls).toEqual(['team-console']);
    stop();
  });

  it('polls at the jobs list cadence: often while a run is on, once a minute when idle', async () => {
    const store = setup();
    answers.push(ok(runningOrchestrationFixture()), ok(idleOrchestrationFixture()));
    const stop = store.watch('team-console');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(LIVE_POLL_MS);
    expect(calls).toHaveLength(2);
    expect(store.isActive()).toBe(false);

    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS - 1);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(3);
    stop();
  });

  it('a failed first read is the error state; a failed later read keeps the run with the failure', async () => {
    const store = setup();
    answers.push(offline);
    const stop = store.watch('team-console');
    await vi.advanceTimersByTimeAsync(0);
    expect(store.status()).toBe('error');
    expect(store.failure()).toEqual({ kind: 'offline', slug: null });

    answers.push(ok(runningOrchestrationFixture()), offline);
    await store.refresh();
    expect(store.status()).toBe('ready');
    expect(store.failure()).toBeNull();
    await store.refresh();
    expect(store.status()).toBe('ready');
    expect(store.run()).toEqual(runningOrchestrationFixture());
    expect(store.failure()?.kind).toBe('offline');
    stop();
  });

  it("takes a command's answer at once and drops a read that was already on its way", async () => {
    const store = setup();
    const stop = store.watch('team-console');
    await vi.advanceTimersByTimeAsync(0);
    answers.push(ok(idleOrchestrationFixture()));
    const stale = store.refresh();
    store.apply(runningOrchestrationFixture());
    await stale;
    expect(store.run()).toEqual(runningOrchestrationFixture());
    stop();
  });

  it('stops polling, and a read in flight never lands after stop', async () => {
    const store = setup();
    const stop = store.watch('team-console');
    stop();
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS * 3);
    expect(calls).toHaveLength(1);
    expect(store.status()).toBe('loading');
  });
});
