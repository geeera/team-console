import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ErrorHandler } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { DesignManifests } from './design-manifests.store';
import { MANIFEST } from './design.model.spec';

const URL_277 = '/api/v1/projects/tc/designs/277';

describe('DesignManifests', () => {
  let http: HttpTestingController;
  let store: DesignManifests;
  const handleError = vi.fn();

  beforeEach(() => {
    handleError.mockReset();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ErrorHandler, useValue: { handleError } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    store = TestBed.inject(DesignManifests);
  });

  afterEach(() => http.verify());

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('loads a manifest once for every reader of the same issue', async () => {
    const first = store.stateOf('tc', 277);
    const second = store.stateOf('tc', 277);
    expect(first().kind).toBe('loading');
    http.expectOne(URL_277).flush(MANIFEST);
    await settle();
    expect(first()).toEqual({ kind: 'ready', manifest: MANIFEST });
    expect(second()).toEqual(first());
  });

  it('keeps a failure until reload, which reads again', async () => {
    const state = store.stateOf('tc', 277);
    http.expectOne(URL_277).flush({ type: 'x' }, { status: 404, statusText: 'Not Found' });
    await settle();
    expect(state()).toEqual({ kind: 'failed', failure: 'no-access' });
    expect(store.stateOf('tc', 277)()).toEqual({ kind: 'failed', failure: 'no-access' });

    const reload = store.reload('tc', 277);
    expect(state().kind).toBe('loading');
    http.expectOne(URL_277).flush(MANIFEST);
    await reload;
    expect(state().kind).toBe('ready');
  });

  it.each([
    ['no-access', 403, {}],
    ['rate-limited', 429, {}],
    ['offline', 0, {}],
    ['unavailable', 503, {}],
  ] as const)('maps a %s answer', async (failure, status, body) => {
    const state = store.stateOf('tc', 1);
    http.expectOne('/api/v1/projects/tc/designs/1').flush(body, { status, statusText: 'x' });
    await settle();
    expect(state()).toEqual({ kind: 'failed', failure });
    expect(handleError).not.toHaveBeenCalled();
  });

  it('treats a body of the wrong shape as unavailable without bothering the error handler', async () => {
    const state = store.stateOf('tc', 2);
    http.expectOne('/api/v1/projects/tc/designs/2').flush({ issue: 'two' });
    await settle();
    expect(state()).toEqual({ kind: 'failed', failure: 'unavailable' });
    expect(handleError).not.toHaveBeenCalled();
  });
});
