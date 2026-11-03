import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ProjectDto } from '@shared/contracts';
import { isProjectDtoList, PROJECTS_URL, ProjectsStore } from './projects.store';

const project = (slug: string, archivedAt: string | null = null): ProjectDto => ({
  slug,
  repo: `geeera/${slug}`,
  displayName: slug,
  routineId: null,
  addedAt: '2026-09-29T00:00:00.000Z',
  archivedAt,
});

describe('ProjectsStore', () => {
  let store: ProjectsStore;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    store = TestBed.inject(ProjectsStore);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('ready() starts one load and resolves when the list is known', async () => {
    const first = store.ready();
    const second = store.ready();
    expect(store.status()).toBe('loading');

    const request = http.expectOne(PROJECTS_URL);
    expect(request.request.method).toBe('GET');
    expect(request.request.body).toBeNull();
    request.flush([project('a'), project('old', '2026-09-30T00:00:00.000Z')]);
    await Promise.all([first, second]);

    expect(store.status()).toBe('ready');
    expect(store.activeSlugs()).toEqual(['a']);
    await store.ready();
  });

  it('upsert lists a project the Worker created; remove drops an archived one at once', async () => {
    const ready = store.ready();
    http.expectOne(PROJECTS_URL).flush([project('a'), project('b')]);
    await ready;
    expect(store.loadedAt()).not.toBeNull();

    store.upsert(project('c'));
    expect(store.activeSlugs()).toEqual(['a', 'b', 'c']);

    store.remove('a');
    expect(store.activeSlugs()).toEqual(['b', 'c']);
    expect(store.isActive('a')).toBe(false);
  });

  it('findRegistered reads archived projects too and matches the repository case-insensitively', async () => {
    const found = store.findRegistered('Geeera/OLD', 'old');
    const request = http.expectOne((req) => req.url === PROJECTS_URL);
    expect(request.request.params.get('include')).toBe('archived');
    request.flush([project('a'), project('old', '2026-09-30T00:00:00.000Z')]);

    await expect(found).resolves.toMatchObject({ slug: 'old', archivedAt: '2026-09-30T00:00:00.000Z' });

    const missing = store.findRegistered('geeera/none', 'none');
    http.expectOne((req) => req.url === PROJECTS_URL).flush([project('a')]);
    await expect(missing).resolves.toBeNull();
  });

  it('isActive is false for an archived or unknown slug', async () => {
    const ready = store.ready();
    http.expectOne(PROJECTS_URL).flush([project('a'), project('old', '2026-09-30T00:00:00.000Z')]);
    await ready;

    expect(store.isActive('a')).toBe(true);
    expect(store.isActive('old')).toBe(false);
    expect(store.isActive('nowhere')).toBe(false);
    expect(store.bySlug('old')).toBeUndefined();
  });

  it('records a failed load as a problem instead of throwing', async () => {
    const ready = store.ready();
    http.expectOne(PROJECTS_URL).flush(
      {
        type: 'https://team-console.dev/problems/github-unavailable',
        title: 'GitHub unavailable',
        status: 502,
      },
      { status: 502, statusText: 'Bad Gateway' },
    );
    await expect(ready).resolves.toBeUndefined();

    expect(store.status()).toBe('error');
    expect(store.problem()?.status).toBe(502);
    expect(store.hasProjects()).toBe(false);
  });

  it('treats a response of the wrong shape as an error', async () => {
    const ready = store.ready();
    http.expectOne(PROJECTS_URL).flush({ projects: [] });
    await ready;

    expect(store.status()).toBe('error');
    expect(store.problem()?.status).toBe(0);
  });

  it('load() after an error retries the request', async () => {
    const ready = store.ready();
    http.expectOne(PROJECTS_URL).error(new ProgressEvent('offline'));
    await ready;
    expect(store.status()).toBe('error');

    const retry = store.load();
    http.expectOne(PROJECTS_URL).flush([project('a')]);
    await retry;

    expect(store.status()).toBe('ready');
    expect(store.hasProjects()).toBe(true);
  });
});

describe('isProjectDtoList', () => {
  it('accepts the registry shape and rejects anything else', () => {
    expect(isProjectDtoList([project('a')])).toBe(true);
    expect(isProjectDtoList([])).toBe(true);
    expect(isProjectDtoList([{ slug: 'a' }])).toBe(false);
    expect(isProjectDtoList({ items: [] })).toBe(false);
  });

  it('accepts a project with or without its snooze (#221), never a malformed one', () => {
    expect(isProjectDtoList([{ ...project('a'), snooze: { snoozed: false } }])).toBe(true);
    expect(
      isProjectDtoList([
        { ...project('a'), snooze: { snoozed: true, until: null, allowsUrgent: true, since: '2026-10-05T10:00:00Z' } },
      ]),
    ).toBe(true);
    expect(isProjectDtoList([{ ...project('a'), snooze: { snoozed: true } }])).toBe(false);
  });
});
