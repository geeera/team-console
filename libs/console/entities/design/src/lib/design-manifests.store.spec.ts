import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ErrorHandler } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { DESIGN_MANIFEST_TTL_MS, DesignManifests } from './design-manifests.store';
import { MANIFEST } from './design.model.spec';

const URL_277 = '/api/v1/projects/tc/designs/277';
const NEW_SHA = 'b'.repeat(40);
const MOVED = { ...MANIFEST, sha: NEW_SHA };

describe('DesignManifests', () => {
  let http: HttpTestingController;
  let store: DesignManifests;
  let now = Date.parse('2026-10-07T10:00:00Z');
  const handleError = vi.fn();

  beforeEach(() => {
    handleError.mockReset();
    now = Date.parse('2026-10-07T10:00:00Z');
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ErrorHandler, useValue: { handleError } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    store = TestBed.inject(DesignManifests);
    store.now = () => now;
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
    // Within the TTL another look reads nothing.
    now += DESIGN_MANIFEST_TTL_MS - 1;
    store.stateOf('tc', 277);
    http.expectNone(URL_277);
  });

  it('reads an old list again on the next look, keeping the current one on screen meanwhile (≤ 60 s)', async () => {
    const state = store.stateOf('tc', 277);
    http.expectOne(URL_277).flush(MANIFEST);
    await settle();

    now += DESIGN_MANIFEST_TTL_MS;
    store.stateOf('tc', 277);
    expect(state()).toEqual({ kind: 'ready', manifest: MANIFEST });
    http.expectOne(URL_277).flush(MOVED);
    await settle();
    expect(state()).toEqual({ kind: 'ready', manifest: MOVED });
  });

  it('reload reads again at once and keeps a ready manifest until the new one arrives; one read for two asks', async () => {
    const state = store.stateOf('tc', 277);
    http.expectOne(URL_277).flush(MANIFEST);
    await settle();

    const reload = store.reload('tc', 277);
    void store.reload('tc', 277);
    expect(state().kind).toBe('ready');
    http.expectOne(URL_277).flush(MOVED);
    await reload;
    expect(state()).toEqual({ kind: 'ready', manifest: MOVED });
  });

  it('a failed refresh keeps the manifest already on screen', async () => {
    const state = store.stateOf('tc', 277);
    http.expectOne(URL_277).flush(MANIFEST);
    await settle();
    const reload = store.reload('tc', 277);
    http.expectOne(URL_277).flush({}, { status: 503, statusText: 'x' });
    await reload;
    expect(state()).toEqual({ kind: 'ready', manifest: MANIFEST });
  });

  it('keeps a failure until reload, which reads again', async () => {
    const state = store.stateOf('tc', 277);
    http.expectOne(URL_277).flush({ type: 'x' }, { status: 404, statusText: 'Not Found' });
    await settle();
    expect(state()).toEqual({ kind: 'failed', failure: 'no-access' });
    expect(store.stateOf('tc', 277)()).toEqual({ kind: 'failed', failure: 'no-access' });
    http.expectNone(URL_277);

    const reload = store.reload('tc', 277);
    expect(state().kind).toBe('loading');
    http.expectOne(URL_277).flush(MANIFEST);
    await reload;
    expect(state().kind).toBe('ready');
  });

  it('recover refetches the list once per sha: true the first time, false for the same sha again', async () => {
    const state = store.stateOf('tc', 277);
    http.expectOne(URL_277).flush(MANIFEST);
    await settle();

    const first = store.recover('tc', 277, MANIFEST.sha);
    http.expectOne(URL_277).flush(MOVED);
    await expect(first).resolves.toBe(true);
    expect(state()).toEqual({ kind: 'ready', manifest: MOVED });

    await expect(store.recover('tc', 277, MANIFEST.sha)).resolves.toBe(false);
    http.expectNone(URL_277);

    // The new sha gets its own one recovery.
    const again = store.recover('tc', 277, NEW_SHA);
    http.expectOne(URL_277).flush(MOVED);
    await expect(again).resolves.toBe(true);
  });

  it('reloadAll reads every manifest of the project again and leaves other projects alone', async () => {
    store.stateOf('tc', 277);
    store.stateOf('tc', 278);
    store.stateOf('other', 1);
    http.expectOne(URL_277).flush(MANIFEST);
    http.expectOne('/api/v1/projects/tc/designs/278').flush({ ...MANIFEST, issue: 278 });
    http.expectOne('/api/v1/projects/other/designs/1').flush({ ...MANIFEST, issue: 1 });
    await settle();

    const all = store.reloadAll('tc');
    http.expectOne(URL_277).flush(MOVED);
    http.expectOne('/api/v1/projects/tc/designs/278').flush({ ...MANIFEST, issue: 278, sha: NEW_SHA });
    http.expectNone('/api/v1/projects/other/designs/1');
    await all;
    expect(store.stateOf('tc', 278)()).toMatchObject({ kind: 'ready', manifest: { sha: NEW_SHA } });
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
