import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ErrorHandler } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { actionsSetupFixture } from './actions-setup.fixture';
import { ActionsSetupApi, actionsSetupUrl } from './actions-setup.api';
import { ACTIONS_AUTO_RECHECK_MS, ActionsSetupState, ActionsSetupStatuses } from './actions-setup.store';

describe('ActionsSetupState', () => {
  let http: HttpTestingController;
  let api: ActionsSetupApi;
  const handleError = vi.fn();
  const URL = actionsSetupUrl('storify');

  beforeEach(() => {
    handleError.mockReset();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: ErrorHandler, useValue: { handleError } }],
    });
    http = TestBed.inject(HttpTestingController);
    api = TestBed.inject(ActionsSetupApi);
  });

  afterEach(() => http.verify());

  async function settle(pending: Promise<unknown>, respond: (request: ReturnType<HttpTestingController['expectOne']>) => void): Promise<void> {
    await Promise.resolve();
    respond(http.expectOne(URL));
    await pending;
  }

  it('keeps the answer and shares one state per project', async () => {
    const statuses = TestBed.inject(ActionsSetupStatuses);
    const state = statuses.of('storify');
    expect(statuses.of('storify')).toBe(state);
    await settle(state.ensureLoaded(), (request) => request.flush(actionsSetupFixture()));
    expect(state.state()).toBe('ready');
    expect(state.snapshot()?.ready).toBe(true);
    await state.ensureLoaded();
  });

  it('keeps the last answer through an offline re-check', async () => {
    const state = new ActionsSetupState(api, 'storify');
    await settle(state.load(), (request) => request.flush(actionsSetupFixture()));
    await settle(state.load(), (request) => request.error(new ProgressEvent('error'), { status: 0 }));
    expect(state.problem()).toEqual({ kind: 'offline' });
    expect(state.snapshot()).not.toBeNull();
  });

  it('drops the answer on 403 so a member sees nothing of it', async () => {
    const state = new ActionsSetupState(api, 'storify');
    await settle(state.load(), (request) => request.flush(actionsSetupFixture()));
    await settle(state.load(), (request) =>
      request.flush({ type: 'https://team-console/problems/owner-only', title: 'x', status: 403 }, { status: 403, statusText: 'Forbidden' }),
    );
    expect(state.problem()).toEqual({ kind: 'forbidden' });
    expect(state.snapshot()).toBeNull();
  });

  it('reports an answer outside the contract and reads it as failed', async () => {
    const state = new ActionsSetupState(api, 'storify');
    await settle(state.load(), (request) => request.flush({ ...actionsSetupFixture(), secretNames: ['OTHER'] }));
    expect(state.problem()).toEqual({ kind: 'failed' });
    expect(handleError).toHaveBeenCalledTimes(1);
  });

  it('re-checks on return at most once per 30 seconds', async () => {
    let now = 1_000_000;
    const state = new ActionsSetupState(api, 'storify', () => now);
    await settle(state.load(), (request) => request.flush(actionsSetupFixture()));
    expect(await state.autoRecheck()).toBe(false);
    now += ACTIONS_AUTO_RECHECK_MS;
    const pending = state.autoRecheck();
    await settle(pending, (request) => request.flush(actionsSetupFixture()));
    expect(await pending).toBe(true);
  });

  it('moves dispatch after a switch without asking again', async () => {
    const state = new ActionsSetupState(api, 'storify');
    await settle(state.load(), (request) => request.flush(actionsSetupFixture()));
    state.applyDispatch('actions');
    expect(state.snapshot()?.dispatch).toBe('actions');
  });
});
