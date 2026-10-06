import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { PROBLEM_TYPE_PREFIX, type TeamStatusDto } from '@shared/contracts';
import { activeLock, isTeamStatusDto, missingSlots } from './team-status.model';
import { TeamStatusStore } from './team-status.store';

function teamStatus(overrides: Partial<TeamStatusDto> = {}): TeamStatusDto {
  const secrets = (slot: string) => ({ token: `SLOT_TOKEN_TC_${slot}`, routine: `SLOT_ROUTINE_TC_${slot}` });
  return {
    state: 'running',
    pausedAt: null,
    runLogUrl: 'https://github.com/geeera/team-console/issues/22',
    ownerConnected: true,
    environment: 'production',
    snooze: { snoozed: false },
    checkedAt: '2026-10-01T12:00:00.000Z',
    slots: [
      { slot: 'pm', setup: 'present', secrets: secrets('PM'), lastRun: null, lock: null },
      { slot: 'dev', setup: 'present', secrets: secrets('DEV'), lastRun: null, lock: null },
      { slot: 'qa', setup: 'missing', secrets: secrets('QA'), lastRun: null, lock: null },
    ],
    ...overrides,
  };
}

describe('team status model', () => {
  it('accepts the Worker answer and refuses anything else', () => {
    expect(isTeamStatusDto(teamStatus())).toBe(true);
    expect(isTeamStatusDto({ ...teamStatus(), state: 'stopped' })).toBe(false);
    expect(isTeamStatusDto({ ...teamStatus(), snooze: undefined })).toBe(false);
    expect(isTeamStatusDto({ ...teamStatus(), snooze: { snoozed: true, until: null } })).toBe(false);
    expect(
      isTeamStatusDto({
        ...teamStatus(),
        snooze: { snoozed: true, until: null, allowsUrgent: true, since: '2026-10-01T11:00:00.000Z' },
      }),
    ).toBe(true);
    expect(isTeamStatusDto({ ...teamStatus(), slots: teamStatus().slots.slice(1) })).toBe(false);
    expect(isTeamStatusDto({ ...teamStatus(), slots: [...teamStatus().slots].reverse() })).toBe(false);
    const badLock = teamStatus();
    expect(
      isTeamStatusDto({
        ...badLock,
        slots: badLock.slots.map((slot) => ({ ...slot, lock: { kind: 'started' } })),
      }),
    ).toBe(false);
  });

  it('lists the slots not set up and drops a lock whose window passed', () => {
    expect(missingSlots(teamStatus())).toEqual(['qa']);
    const lock = { kind: 'requested', since: '2026-10-01T12:00:00Z', until: '2026-10-01T12:15:00Z' } as const;
    const [first] = teamStatus().slots;
    if (first === undefined) {
      throw new Error('fixture without slots');
    }
    const slot = { ...first, lock };
    expect(activeLock(slot, Date.parse('2026-10-01T12:14:59Z'))).toEqual(lock);
    expect(activeLock(slot, Date.parse('2026-10-01T12:15:00Z'))).toBeNull();
  });
});

describe('TeamStatusStore', () => {
  let store: TeamStatusStore;
  let http: HttpTestingController;
  const URL = '/api/v1/projects/tc/team/status';

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    store = TestBed.inject(TeamStatusStore);
    http = TestBed.inject(HttpTestingController);
  });

  it('loads the status of a project, then refreshes it in place', async () => {
    const first = store.load('tc');
    expect(store.phase()).toBe('loading');
    http.expectOne(URL).flush(teamStatus());
    await first;
    expect(store.phase()).toBe('ready');
    expect(store.status()?.state).toBe('running');

    const again = store.refresh();
    expect(store.refreshing()).toBe(true);
    http.expectOne(URL).flush(teamStatus({ state: 'paused-by-team' }));
    await again;
    expect(store.refreshing()).toBe(false);
    expect(store.status()?.state).toBe('paused-by-team');
  });

  it('a failed first read is an error with the problem; a failed refresh keeps the status shown', async () => {
    const first = store.load('tc');
    http
      .expectOne(URL)
      .flush(
        { type: `${PROBLEM_TYPE_PREFIX}github-unavailable`, title: 'x', status: 502 },
        { status: 502, statusText: 'x' },
      );
    await first;
    expect(store.phase()).toBe('error');
    expect(store.problem()?.slug).toBe('github-unavailable');

    const second = store.load('tc');
    http.expectOne(URL).flush(teamStatus());
    await second;
    const third = store.refresh();
    http.expectOne(URL).flush({}, { status: 0, statusText: 'offline' });
    await third;
    expect(store.phase()).toBe('ready');
    expect(store.status()).not.toBeNull();
    expect(store.problem()?.status).toBe(0);
  });

  it('a malformed answer is an error, and a newer project wins over an older read', async () => {
    const bad = store.load('tc');
    http.expectOne(URL).flush({ state: 'running' });
    await bad;
    expect(store.phase()).toBe('error');

    const old = store.load('tc');
    const fresh = store.load('other');
    http.expectOne('/api/v1/projects/other/team/status').flush(teamStatus({ state: 'paused-by-owner' }));
    http.expectOne(URL).flush(teamStatus());
    await Promise.all([old, fresh]);
    expect(store.slug()).toBe('other');
    expect(store.status()?.state).toBe('paused-by-owner');
  });

  it('takes a command result at once', async () => {
    const first = store.load('tc');
    http.expectOne(URL).flush(teamStatus());
    await first;
    store.applyState('paused-by-owner', '2026-10-01T12:01:00Z');
    expect(store.status()).toMatchObject({ state: 'paused-by-owner', pausedAt: '2026-10-01T12:01:00Z' });
    const lock = { kind: 'requested', since: 'a', until: 'b' } as const;
    store.applyLock('dev', lock);
    expect(store.status()?.slots[1]?.lock).toEqual(lock);
    store.applyState('running', 'ignored');
    expect(store.status()?.pausedAt).toBeNull();
  });
});
