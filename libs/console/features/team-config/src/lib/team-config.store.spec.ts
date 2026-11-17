import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { TEAM_CONFIG_SCHEMA, problemTypeOf, type TeamConfig } from '@shared/contracts';
import { isTeamConfigView, teamConfigUrlOf } from './team-config.client';
import { SLOW_LOAD_MS, TeamConfigStore } from './team-config.store';
import { teamConfigViewOf } from './testing';

const URL = teamConfigUrlOf('acme');
const stored: TeamConfig = { schema: TEAM_CONFIG_SCHEMA, access: { source: 'api_key' }, budget: { monthly_usd: 200 } };

const flush = async (): Promise<void> => {
  for (let i = 0; i < 3; i += 1) {
    await Promise.resolve();
  }
};

function setup(): { store: TeamConfigStore; http: HttpTestingController } {
  TestBed.configureTestingModule({
    providers: [provideHttpClient(), provideHttpClientTesting(), TeamConfigStore],
  });
  return { store: TestBed.inject(TeamConfigStore), http: TestBed.inject(HttpTestingController) };
}

async function loaded(view = teamConfigViewOf(stored, { revision: 12 })): Promise<{
  store: TeamConfigStore;
  http: HttpTestingController;
}> {
  const context = setup();
  const loading = context.store.load('acme');
  context.http.expectOne(URL).flush(view);
  await loading;
  return context;
}

function problem(status: number, type: string, field?: string): { body: object; init: { status: number; statusText: string } } {
  return {
    body: { type: problemTypeOf(type), title: 'x', status, ...(field === undefined ? {} : { field }) },
    init: { status, statusText: 'x' },
  };
}

function answer(request: TestRequest, failure: ReturnType<typeof problem>): void {
  request.flush(failure.body, failure.init);
}

async function saveAnswering(
  store: TeamConfigStore,
  http: HttpTestingController,
  failure: ReturnType<typeof problem>,
): Promise<Awaited<ReturnType<TeamConfigStore['save']>>> {
  const saving = store.save('why');
  await flush();
  const request = http.expectOne((req) => req.method === 'PUT' && req.url === URL);
  expect(request.request.headers.get('If-Match')).toBe('"12"');
  request.flush(failure.body, failure.init);
  return saving;
}

describe('TeamConfigStore', () => {
  afterEach(() => vi.useRealTimers());

  it('loads the view, says "still loading" after 3 s, and counts nothing as changed', async () => {
    vi.useFakeTimers();
    const { store, http } = setup();
    const loading = store.load('acme');
    expect(store.status()).toBe('loading');
    vi.advanceTimersByTime(SLOW_LOAD_MS);
    expect(store.isSlow()).toBe(true);
    http.expectOne(URL).flush(teamConfigViewOf(stored));
    await loading;
    expect(store.status()).toBe('ready');
    expect(store.isDirty()).toBe(false);
    expect(store.canEdit()).toBe(true);
  });

  it('turns a failed or malformed read into the error state, and a 404 into not-found', async () => {
    const { store, http } = setup();
    let loading = store.load('acme');
    http.expectOne(URL).flush({ config: null }, { status: 200, statusText: 'OK' });
    await loading;
    expect(store.status()).toBe('error');
    loading = store.load('acme');
    answer(http.expectOne(URL), problem(404, 'project-not-found'));
    await loading;
    expect(store.status()).toBe('not-found');
  });

  it('never lets a member edit: the owner signal is the Worker’s', async () => {
    const { store } = await loaded(teamConfigViewOf(stored, { revision: 12, canManage: false }));
    expect(store.canEdit()).toBe(false);
  });

  it('saves the draft over its revision with the reason, and adopts the new revision', async () => {
    const { store, http } = await loaded();
    store.edit('budget.monthly_usd', 250);
    expect(store.changes()).toEqual([{ path: 'budget.monthly_usd', from: 200, to: 250 }]);
    const saving = store.save('  raised  ');
    await flush();
    const request = http.expectOne((req) => req.method === 'PUT');
    expect(request.request.body).toEqual({
      config: { schema: TEAM_CONFIG_SCHEMA, access: { source: 'api_key' }, budget: { monthly_usd: 250 } },
      reason: 'raised',
    });
    request.flush(teamConfigViewOf({ ...stored, budget: { monthly_usd: 250 } }, { revision: 13 }));
    expect((await saving).kind).toBe('saved');
    expect(store.view()?.revision).toBe(13);
    expect(store.isDirty()).toBe(false);
  });

  it('marks the field a 422 names, and access.source on access-source-hosted', async () => {
    const { store, http } = await loaded();
    store.edit('roles.dev.max_turns', 999);
    expect(await saveAnswering(store, http, problem(422, 'team-config-invalid', 'roles.dev.max_turns'))).toEqual({
      kind: 'invalid',
      field: 'roles.dev.max_turns',
    });
    expect(store.errors().get('roles.dev.max_turns')).toEqual({ key: 'teamConfig.error.invalid' });
    expect(await saveAnswering(store, http, problem(422, 'access-source-hosted', 'access.source'))).toEqual({ kind: 'hosted' });
    expect(store.errors().has('access.source')).toBe(true);
    expect(store.isDirty()).toBe(true);
  });

  it('on 412 reads the revision that won, never overwrites it, and can keep my edits on top', async () => {
    const { store, http } = await loaded();
    store.edit('budget.monthly_usd', 250);
    const theirs = teamConfigViewOf({ ...stored, sprint: { length_days: 21 } }, { revision: 13, updatedByName: 'anna' });
    const saving = store.save('');
    await flush();
    answer(http.expectOne((req) => req.method === 'PUT'), problem(412, 'team-config-stale'));
    await flush();
    http.expectOne((req) => req.method === 'GET' && req.url === URL).flush(theirs);
    expect((await saving).kind).toBe('stale');
    expect(store.banner()?.kind).toBe('conflict');
    expect(store.theirChanges()).toEqual([{ path: 'sprint.length_days', from: 14, to: 21 }]);
    expect(store.keepMine()).toEqual([]);
    expect(store.view()?.revision).toBe(13);
    expect(store.draft()?.monthlyUsd).toBe(250);
    expect(store.draft()?.sprint.length_days).toBe(21);
    expect(store.changes()).toEqual([{ path: 'budget.monthly_usd', from: 200, to: 250 }]);
  });

  it('discards mine after a conflict: their revision, no edits', async () => {
    const { store, http } = await loaded();
    store.edit('budget.monthly_usd', 250);
    const saving = store.save('');
    await flush();
    answer(http.expectOne((req) => req.method === 'PUT'), problem(412, 'team-config-stale'));
    await flush();
    http.expectOne((req) => req.method === 'GET' && req.url === URL).flush(teamConfigViewOf(stored, { revision: 13 }));
    await saving;
    store.discardMine();
    expect(store.banner()).toBeNull();
    expect(store.isDirty()).toBe(false);
    expect(store.view()?.revision).toBe(13);
  });

  it('keeps the edits read-only on 403, and keeps them for Try again on a network error', async () => {
    const { store, http } = await loaded();
    store.edit('budget.monthly_usd', 250);
    expect((await saveAnswering(store, http, problem(503, 'unavailable'))).kind).toBe('failed');
    expect(store.isDirty()).toBe(true);
    expect((await saveAnswering(store, http, problem(403, 'owner-only'))).kind).toBe('forbidden');
    expect(store.banner()).toEqual({ kind: 'forbidden' });
    expect(store.canEdit()).toBe(false);
    expect(store.isDirty()).toBe(true);
  });
});

describe('isTeamConfigView', () => {
  it('accepts the Worker’s view and refuses one without the owner signal', () => {
    const view = teamConfigViewOf(stored);
    expect(isTeamConfigView(view)).toBe(true);
    const { canManage: _canManage, ...withoutOwner } = view;
    expect(isTeamConfigView(withoutOwner)).toBe(false);
  });
});
