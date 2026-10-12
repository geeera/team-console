import { HttpErrorResponse, HttpHeaders, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ErrorHandler } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { PROBLEM_TYPE_PREFIX } from '@shared/contracts';
import { InstallationRepositoriesStore, repositoriesProblemOf } from './installation-repositories.store';

const URL = '/api/v1/github/installation/repositories';
const PREFIX = PROBLEM_TYPE_PREFIX;
const NOW = Date.parse('2026-10-05T12:00:00Z');

const dto = (names: readonly string[] = ['geeera/storify']) => ({
  repositories: names.map((fullName) => ({ fullName, private: false, registration: { state: 'none' } })),
  partial: false,
  selectionUrl: 'https://github.com/settings/installations/1001',
});

function problem(status: number, slug: string, extra: Record<string, unknown> = {}, headers?: HttpHeaders) {
  return new HttpErrorResponse({
    status,
    error: { type: `${PREFIX}${slug}`, title: slug, status, ...extra },
    ...(headers === undefined ? {} : { headers }),
  });
}

describe('repositoriesProblemOf', () => {
  it.each([
    ['not connected', problem(403, 'github-owner-not-connected'), { kind: 'not-connected' }],
    ['GitHub down', problem(502, 'github-unavailable'), { kind: 'github' }],
    ['an unexpected answer', problem(502, 'github-unexpected'), { kind: 'github' }],
    ['the app credential', problem(503, 'github-auth'), { kind: 'auth' }],
    ['no response', new HttpErrorResponse({ status: 0 }), { kind: 'offline' }],
    ['a bug, not HTTP', new Error('x'), { kind: 'github' }],
  ])('maps %s', (_label, error, expected) => {
    expect(repositoriesProblemOf(error, NOW)).toEqual(expected);
  });

  it('maps not installed with the server install link, and drops a link off github.com', () => {
    expect(
      repositoriesProblemOf(
        problem(409, 'github-app-not-installed', {
          installUrl: 'https://github.com/apps/team-console-dev/installations/new',
        }),
      ),
    ).toEqual({
      kind: 'not-installed',
      installUrl: 'https://github.com/apps/team-console-dev/installations/new',
    });
    expect(
      repositoriesProblemOf(
        problem(409, 'github-app-not-installed', { installUrl: 'https://evil.example/' }),
      ),
    ).toEqual({ kind: 'not-installed', installUrl: null });
  });

  it('maps the rate limit to the time from Retry-After, a minute without it', () => {
    expect(
      repositoriesProblemOf(
        problem(429, 'github-rate-limit', {}, new HttpHeaders({ 'Retry-After': '42' })),
        NOW,
      ),
    ).toEqual({ kind: 'rate', retryAt: '2026-10-05T12:00:42.000Z' });
    expect(repositoriesProblemOf(problem(429, 'github-rate-limit'), NOW)).toEqual({
      kind: 'rate',
      retryAt: '2026-10-05T12:01:00.000Z',
    });
  });
});

describe('InstallationRepositoriesStore', () => {
  function setup() {
    const handled: unknown[] = [];
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ErrorHandler, useValue: { handleError: (error: unknown) => handled.push(error) } },
      ],
    });
    return {
      store: TestBed.inject(InstallationRepositoriesStore),
      http: TestBed.inject(HttpTestingController),
      handled,
    };
  }

  it('loads, then reloads with fresh while keeping the rows on screen', async () => {
    const { store, http } = setup();
    const first = store.load();
    expect(store.status()).toBe('loading');
    http.expectOne(URL).flush(dto());
    await expect(first).resolves.toBe('ready');
    expect(store.repositories().map((row) => row.fullName)).toEqual(['geeera/storify']);
    expect(store.loadedAt()).not.toBeNull();

    const again = store.load({ fresh: true });
    expect(store.status()).toBe('ready');
    expect(store.refreshing()).toBe(true);
    http.expectOne(`${URL}?fresh=1`).flush(dto(['geeera/a', 'geeera/b']));
    await again;
    expect(store.refreshing()).toBe(false);
    expect(store.repositories()).toHaveLength(2);
  });

  it('shows an error state for a failed first load', async () => {
    const { store, http } = setup();
    const load = store.load();
    http
      .expectOne(URL)
      .flush(
        { type: `${PREFIX}github-auth`, title: 'x', status: 503 },
        { status: 503, statusText: 'Service Unavailable' },
      );
    await expect(load).resolves.toBe('error');
    expect(store.status()).toBe('error');
    expect(store.problem()).toEqual({ kind: 'auth' });
  });

  it('keeps a loaded list when a reload finds no network', async () => {
    const { store, http } = setup();
    const first = store.load();
    http.expectOne(URL).flush(dto());
    await first;
    const reload = store.load({ fresh: true });
    http.expectOne(`${URL}?fresh=1`).error(new ProgressEvent('error'), { status: 0 });
    await expect(reload).resolves.toBe('error');
    expect(store.status()).toBe('ready');
    expect(store.repositories()).toHaveLength(1);
  });

  it('reports a response of another shape and shows the GitHub error', async () => {
    const { store, http, handled } = setup();
    const load = store.load();
    http.expectOne(URL).flush({ repositories: 'x' });
    await load;
    expect(store.problem()).toEqual({ kind: 'github' });
    expect(handled).toEqual([]);
  });

  it('turns one row into a project without a reload', async () => {
    const { store, http } = setup();
    const load = store.load();
    http.expectOne(URL).flush(dto(['geeera/storify', 'geeera/other']));
    await load;
    store.markRegistered('GEEERA/Storify', 'storify');
    expect(store.repositories().map((row) => row.registration)).toEqual([
      { state: 'active', slug: 'storify' },
      { state: 'none' },
    ]);
  });
});
