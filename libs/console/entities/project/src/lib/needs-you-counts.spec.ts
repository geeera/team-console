import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { NeedsYouDto } from '@shared/contracts';
import { ANSWERED_ITEMS_STORAGE, AnsweredItems } from './answered-items';
import { countNeedsYouBySlug, NEEDS_YOU_REFRESH_MS, NEEDS_YOU_URL, NeedsYouCounts } from './needs-you-counts';
import { PROJECTS_URL, ProjectsStore } from './projects.store';

const counted = (entries: Record<string, number>): ReadonlyMap<string, number> =>
  new Map(Object.entries(entries));

describe('countNeedsYouBySlug', () => {
  it('counts items per project slug from a bare array or an items envelope', () => {
    const items = [{ project: 'a' }, { project: 'a' }, { project: { slug: 'b' } }, { project: 3 }, 'junk'];

    expect(countNeedsYouBySlug(items)).toEqual(counted({ a: 2, b: 1 }));
    expect(countNeedsYouBySlug({ items })).toEqual(counted({ a: 2, b: 1 }));
  });

  it('counts the real GET /api/v1/needs-you body (#35 NeedsYouDto), untrusted items included', () => {
    const item = (slug: string, number: number, authorTrusted: boolean): NeedsYouDto['items'][number] => ({
      section: 'question',
      number,
      title: `#${number}`,
      url: `https://github.com/geeera/${slug}/issues/${number}`,
      ask: null,
      authorTrusted,
      category: null,
      recommendation: null,
      project: { slug, name: slug },
      allowedCommands: ['approve', 'reject'],
    });
    const body: NeedsYouDto = {
      items: [item('team-console', 72, true), item('team-console', 90001, false), item('storify', 151, true)],
      projects: [],
      omittedProjects: [],
    };

    expect(countNeedsYouBySlug(body)).toEqual(counted({ 'team-console': 2, storify: 1 }));
  });

  it('counts slugs that are Object.prototype member names like any other slug', () => {
    const items = ['constructor', 'constructor', '__proto__', 'toString', 'hasOwnProperty'].map((slug) => ({
      project: { slug, name: slug },
    }));

    const counts = countNeedsYouBySlug({ items });

    expect(counts.get('constructor')).toBe(2);
    expect(counts.get('__proto__')).toBe(1);
    expect(counts.get('toString')).toBe(1);
    expect(counts.get('hasOwnProperty')).toBe(1);
    expect(counts.get('valueOf')).toBeUndefined();
  });

  it('gives no counts for anything else', () => {
    expect(countNeedsYouBySlug(null).size).toBe(0);
    expect(countNeedsYouBySlug({ total: 3 }).size).toBe(0);
    expect(countNeedsYouBySlug('x').size).toBe(0);
  });
});

describe('NeedsYouCounts', () => {
  let counts: NeedsYouCounts;
  let http: HttpTestingController;

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ANSWERED_ITEMS_STORAGE, useValue: { read: () => null, write: () => undefined } },
      ],
    });
    counts = TestBed.inject(NeedsYouCounts);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('refresh() reads the counts with a bodiless GET', async () => {
    const done = counts.refresh();
    const request = http.expectOne(NEEDS_YOU_URL);
    expect(request.request.method).toBe('GET');
    expect(request.request.body).toBeNull();
    request.flush([{ project: 'a' }, { project: 'a' }]);
    await done;

    expect(counts.countOf('a')).toBe(2);
    expect(counts.countOf('b')).toBe(0);
    expect(counts.total()).toBe(2);
  });

  it('leaves an archived project out of the total once the project list is known', async () => {
    const projects = TestBed.inject(ProjectsStore);
    const loaded = projects.load();
    http.expectOne(PROJECTS_URL).flush([
      {
        slug: 'a',
        repo: 'geeera/a',
        displayName: 'a',
        routineId: null,
        addedAt: '2026-09-29T00:00:00.000Z',
        archivedAt: null,
      },
      {
        slug: 'b',
        repo: 'geeera/b',
        displayName: 'b',
        routineId: null,
        addedAt: '2026-09-29T00:00:00.000Z',
        archivedAt: null,
      },
    ]);
    await loaded;
    const done = counts.refresh();
    http.expectOne(NEEDS_YOU_URL).flush([{ project: 'a' }, { project: 'b' }, { project: 'b' }]);
    await done;
    expect(counts.total()).toBe(3);

    projects.remove('b');
    expect(counts.total()).toBe(1);
  });

  it('a constructor slug starts at zero, not at an Object.prototype function', () => {
    expect(counts.countOf('constructor')).toBe(0);
    expect(counts.countOf('__proto__')).toBe(0);
    expect(counts.total()).toBe(0);
  });

  it('leaves out the items answered from this device while GitHub still lists them', async () => {
    const done = counts.refresh();
    http.expectOne(NEEDS_YOU_URL).flush({
      items: [
        { project: { slug: 'tc', name: 'TC' }, number: 72 },
        { project: { slug: 'tc', name: 'TC' }, number: 73 },
      ],
    });
    await done;
    expect(counts.countOf('tc')).toBe(2);

    TestBed.inject(AnsweredItems).record({
      slug: 'tc',
      number: 72,
      command: 'approve',
      url: 'https://github.com/geeera/team-console/issues/72#issuecomment-1',
      answeredAt: new Date().toISOString(),
    });

    expect(counts.countOf('tc')).toBe(1);
    expect(counts.total()).toBe(1);
  });

  it('keeps the last counts when the endpoint is unavailable', async () => {
    const first = counts.refresh();
    http.expectOne(NEEDS_YOU_URL).flush([{ project: 'a' }]);
    await first;

    const second = counts.refresh();
    http
      .expectOne(NEEDS_YOU_URL)
      .flush(
        { type: 'about:blank', title: 'Not Found', status: 404 },
        { status: 404, statusText: 'Not Found' },
      );
    await expect(second).resolves.toBeUndefined();

    expect(counts.countOf('a')).toBe(1);
  });

  it('start() refreshes now, on return to the foreground and every minute while visible', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const settle = async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(0);
    };
    const stop = counts.start();
    http.expectOne(NEEDS_YOU_URL).flush([]);
    await settle();

    await vi.advanceTimersByTimeAsync(NEEDS_YOU_REFRESH_MS);
    http.expectOne(NEEDS_YOU_URL).flush([]);
    await settle();

    visibility.mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(NEEDS_YOU_REFRESH_MS * 3);
    http.expectNone(NEEDS_YOU_URL);

    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    http.expectOne(NEEDS_YOU_URL).flush([]);
    await settle();

    stop();
    await vi.advanceTimersByTimeAsync(NEEDS_YOU_REFRESH_MS * 2);
    document.dispatchEvent(new Event('visibilitychange'));
    http.expectNone(NEEDS_YOU_URL);
  });
});
