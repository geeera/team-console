import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { PROBLEM_TYPE_PREFIX } from '@shared/contracts';
import {
  BatchApproveClient,
  batchAnswerUrl,
  batchFailureKindOf,
  batchResultsOf,
} from './batch-approve.client';

const problem = (slug: string, status: number) => ({
  type: `${PROBLEM_TYPE_PREFIX}${slug}`,
  title: 'x',
  status,
});

describe('batchFailureKindOf', () => {
  it.each([
    ['github-owner-not-connected', 'connect'],
    ['github-owner-mismatch', 'mismatch'],
    ['github-rate-limit', 'rate'],
    ['batch-not-safe', 'changed'],
    ['issue-closed', 'changed'],
    ['answer-not-waiting', 'changed'],
    ['github-not-found', 'changed'],
    ['github-unavailable', 'github'],
    ['answer-in-progress', 'github'],
    [null, 'github'],
  ] as const)('%s → %s', (slug, kind) => {
    expect(batchFailureKindOf(slug)).toBe(kind);
  });
});

describe('batchResultsOf', () => {
  const ok = { number: 1, ok: true, commentId: 5, url: 'https://github.com/o/r/issues/1#c', replayed: false };
  const failed = { number: 2, ok: false, problem: problem('github-unavailable', 502) };

  it('keeps one result per number, in order', () => {
    expect(batchResultsOf({ results: [ok, failed] }, [1, 2])).toEqual([ok, failed]);
  });

  it.each([
    ['a missing result', { results: [ok] }],
    ['results out of order', { results: [failed, ok] }],
    ['a failure without a problem', { results: [ok, { number: 2, ok: false }] }],
    ['a written item without its url', { results: [{ ...ok, url: 1 }, failed] }],
    ['no results', {}],
  ])('refuses %s', (_, body) => {
    expect(batchResultsOf(body, [1, 2])).toBeNull();
  });
});

describe('BatchApproveClient', () => {
  let client: BatchApproveClient;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    client = TestBed.inject(BatchApproveClient);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('posts one project’s numbers and words and returns the results', async () => {
    const pending = client.submit('team console', { numbers: [72], ownerSaid: 'да' });
    const request = http.expectOne(batchAnswerUrl('team console'));
    expect(request.request.method).toBe('POST');
    expect(request.request.url).toBe('/api/v1/projects/team%20console/answers/batch');
    expect(request.request.body).toEqual({ numbers: [72], ownerSaid: 'да' });
    const results = [
      { number: 72, ok: true, commentId: 1, url: 'https://github.com/o/r/issues/72', replayed: false },
    ];
    request.flush({ results });
    expect(await pending).toEqual({ ok: true, results });
  });

  it('turns a refused request into its kind, by problem type', async () => {
    const pending = client.submit('tc', { numbers: [1], ownerSaid: 'да' });
    http
      .expectOne(batchAnswerUrl('tc'))
      .flush(problem('github-owner-not-connected', 403), { status: 403, statusText: 'Forbidden' });
    expect(await pending).toEqual({ ok: false, failure: 'connect' });
  });

  it('is offline when no response arrives, and github for an unreadable 2xx', async () => {
    const offline = client.submit('tc', { numbers: [1], ownerSaid: 'да' });
    http.expectOne(batchAnswerUrl('tc')).error(new ProgressEvent('error'), { status: 0 });
    expect(await offline).toEqual({ ok: false, failure: 'offline' });

    const garbled = client.submit('tc', { numbers: [1], ownerSaid: 'да' });
    http.expectOne(batchAnswerUrl('tc')).flush({ results: 'nope' });
    expect(await garbled).toEqual({ ok: false, failure: 'github' });
  });

  it('never sends an empty or oversized batch', async () => {
    await expect(client.submit('tc', { numbers: [], ownerSaid: 'да' })).rejects.toThrow();
    await expect(
      client.submit('tc', { numbers: Array.from({ length: 16 }, (_, i) => i + 1), ownerSaid: 'да' }),
    ).rejects.toThrow();
  });
});
