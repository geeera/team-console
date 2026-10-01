import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { countNeedsYouBySlug, NEEDS_YOU_REFRESH_MS, NEEDS_YOU_URL, NeedsYouCounts } from './needs-you-counts';

describe('countNeedsYouBySlug', () => {
  it('counts items per project slug from a bare array or an items envelope', () => {
    const items = [{ project: 'a' }, { project: 'a' }, { project: { slug: 'b' } }, { project: 3 }, 'junk'];

    expect(countNeedsYouBySlug(items)).toEqual({ a: 2, b: 1 });
    expect(countNeedsYouBySlug({ items })).toEqual({ a: 2, b: 1 });
  });

  it('gives no counts for anything else', () => {
    expect(countNeedsYouBySlug(null)).toEqual({});
    expect(countNeedsYouBySlug({ total: 3 })).toEqual({});
    expect(countNeedsYouBySlug('x')).toEqual({});
  });
});

describe('NeedsYouCounts', () => {
  let counts: NeedsYouCounts;
  let http: HttpTestingController;

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
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
