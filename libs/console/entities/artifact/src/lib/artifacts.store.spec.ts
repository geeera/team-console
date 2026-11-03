import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ErrorHandler } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ArtifactsResponse } from '@shared/contracts';
import { artifactsSnapshotOf } from './artifact.model';
import { ArtifactsStore } from './artifacts.store';

const BODY: ArtifactsResponse = {
  loadedAt: '2026-10-04T10:00:00Z',
  items: [
    {
      type: 'decision',
      title: '0001 — Stack',
      url: 'https://github.com/o/r/blob/dev/docs/decisions/0001.md',
      updatedAt: null,
      source: 'file',
      state: null,
    },
  ],
};

describe('artifactsSnapshotOf', () => {
  it('keeps valid items and drops one whose link is not a github.com page', () => {
    const snapshot = artifactsSnapshotOf({
      ...BODY,
      items: [
        ...BODY.items,
        { ...BODY.items[0], url: 'javascript:alert(1)' },
        { ...BODY.items[0], type: 'x' },
      ],
      partial: ['demo', 'unknown'],
    });
    expect(snapshot?.items).toEqual(BODY.items);
    expect(snapshot?.partial).toEqual(['demo']);
  });

  it('refuses a body without items or loadedAt', () => {
    expect(artifactsSnapshotOf({ items: [] })).toBeNull();
    expect(artifactsSnapshotOf({ loadedAt: 'x', items: {} })).toBeNull();
    expect(artifactsSnapshotOf(null)).toBeNull();
  });
});

describe('ArtifactsStore', () => {
  let http: HttpTestingController;
  let store: ArtifactsStore;
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
    store = TestBed.inject(ArtifactsStore);
  });

  afterEach(() => http.verify());

  it('loads a project and keeps the list on screen while "Check again" asks for a fresh read', async () => {
    const loading = store.load('tc');
    expect(store.state().kind).toBe('loading');
    http.expectOne('/api/v1/projects/tc/artifacts').flush(BODY);
    await loading;
    expect(store.snapshot()?.items).toHaveLength(1);

    const again = store.checkAgain();
    expect(store.state()).toMatchObject({ kind: 'ready', refreshing: true });
    http.expectOne('/api/v1/projects/tc/artifacts?fresh=1').flush(BODY);
    await again;
    expect(store.state()).toMatchObject({ kind: 'ready', refreshing: false });
  });

  it('maps a 429 to rate-limited, app-not-installed to not-installed and status 0 to offline', async () => {
    const cases: [object, number, string][] = [
      [
        { type: 'https://team-console/problems/github-rate-limit', title: 'x', status: 429 },
        429,
        'rate-limited',
      ],
      [
        { type: 'https://team-console/problems/github-app-not-installed', title: 'x', status: 403 },
        403,
        'not-installed',
      ],
    ];
    for (const [problem, status, failure] of cases) {
      const load = store.load('tc');
      http
        .expectOne('/api/v1/projects/tc/artifacts')
        .flush(problem, { status, statusText: 'x', headers: { 'Content-Type': 'application/problem+json' } });
      await load;
      expect(store.state()).toMatchObject({ kind: 'failed', failure });
    }
    const offline = store.load('tc');
    http.expectOne('/api/v1/projects/tc/artifacts').error(new ProgressEvent('error'), { status: 0 });
    await offline;
    expect(store.state()).toMatchObject({ kind: 'failed', failure: 'offline' });
  });

  it('shows a bad shape as unavailable without reporting it as a bug', async () => {
    const load = store.load('tc');
    http.expectOne('/api/v1/projects/tc/artifacts').flush({ nope: true });
    await load;
    expect(store.state()).toMatchObject({ kind: 'failed', failure: 'unavailable' });
    expect(handleError).not.toHaveBeenCalled();
  });

  it('ignores an answer for a project the owner already left', async () => {
    const first = store.load('a');
    const second = store.load('b');
    http.expectOne('/api/v1/projects/a/artifacts').flush(BODY);
    http.expectOne('/api/v1/projects/b/artifacts').flush({ ...BODY, items: [] });
    await Promise.all([first, second]);
    expect(store.state()).toMatchObject({ kind: 'ready', slug: 'b' });
    expect(store.snapshot()?.items).toEqual([]);
  });
});
