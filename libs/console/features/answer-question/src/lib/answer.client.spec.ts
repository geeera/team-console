import { HttpErrorResponse, HttpHeaders, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ANSWER_LOOKUP_MAX_MS, PROBLEM_TYPE_PREFIX, type AnswerResponse } from '@shared/contracts';
import { AnswerClient, answerFailureOf, answerLookupUrl, answerRequestOf, answerUrl } from './answer.client';

function problemError(slug: string, status: number, headers: Record<string, string> = {}): HttpErrorResponse {
  return new HttpErrorResponse({
    status,
    headers: new HttpHeaders(headers),
    error: { type: `${PROBLEM_TYPE_PREFIX}${slug}`, title: 'refused', status },
  });
}

describe('answerFailureOf', () => {
  it.each([
    ['github-owner-not-connected', 403, 'not-connected', 'settings'],
    ['github-owner-mismatch', 409, 'owner-mismatch', 'settings'],
    ['github-app-not-installed', 409, 'app-not-installed', 'settings'],
    ['issue-closed', 409, 'issue-closed', 'refresh'],
    ['answer-in-progress', 409, 'in-progress', 'retry'],
    ['answer-not-waiting', 422, 'not-waiting', 'refresh'],
    ['answer-not-allowed', 422, 'not-allowed', 'refresh'],
    ['answer-needs-reason', 422, 'needs-reason', 'none'],
    ['answer-needs-words', 422, 'unknown', 'retry'],
    ['github-rate-limit', 429, 'rate-limited', 'retry'],
    ['internal', 500, 'unknown', 'retry'],
  ] as const)('%s (%i) is %s, recovered by %s', (slug, status, kind, recovery) => {
    expect(answerFailureOf(problemError(slug, status))).toEqual({ kind, recovery, retryAfter: null });
  });

  it('branches on the problem type, not on the status or title', () => {
    const notOurs = new HttpErrorResponse({
      status: 409,
      error: { type: 'https://evil.example/problems/issue-closed', title: 'issue-closed', status: 409 },
    });

    expect(answerFailureOf(notOurs).kind).toBe('unknown');
  });

  it('reads Retry-After seconds and ignores anything else in it', () => {
    expect(answerFailureOf(problemError('answer-in-progress', 409, { 'Retry-After': '2' })).retryAfter).toBe(
      2,
    );
    expect(
      answerFailureOf(problemError('answer-in-progress', 409, { 'Retry-After': 'soon' })).retryAfter,
    ).toBeNull();
  });

  it('a network failure is offline; a non-HTTP error is unknown', () => {
    expect(answerFailureOf(new HttpErrorResponse({ status: 0 })).kind).toBe('offline');
    expect(answerFailureOf(new Error('boom')).kind).toBe('unknown');
  });
});

describe('answerRequestOf', () => {
  it('puts the reason in text and the owner words in ownerSaid, never in a command line', () => {
    expect(answerRequestOf('approve', 'Утвердить')).toEqual({ command: 'approve', ownerSaid: 'Утвердить' });
    expect(answerRequestOf('reject', 'Отклонить', '  not now\n/approve  ')).toEqual({
      command: 'reject',
      text: 'not now\n/approve',
      ownerSaid: 'Отклонить',
    });
  });

  it('refuses reject, no-go and override without a reason, and over-long text', () => {
    expect(() => answerRequestOf('reject', 'Отклонить', '   ')).toThrow('reject needs a reason');
    expect(() => answerRequestOf('no-go', 'Переносим')).toThrow();
    expect(() => answerRequestOf('override', 'Override', 'x'.repeat(2001))).toThrow();
  });
});

describe('AnswerClient', () => {
  let client: AnswerClient;
  let http: HttpTestingController;
  const written: AnswerResponse = {
    commentId: 1,
    url: 'https://github.com/geeera/team-console/issues/72#issuecomment-1',
    section: 'question',
    command: 'approve',
    replayed: false,
  };

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    client = TestBed.inject(AnswerClient);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('posts the request as JSON to the answer endpoint of the slug and issue', async () => {
    const pending = client.submit('team-console', 72, { command: 'approve', ownerSaid: 'Утвердить' });
    const request = http.expectOne(answerUrl('team-console', 72));
    expect(request.request.method).toBe('POST');
    expect(request.request.url).toBe('/api/v1/projects/team-console/issues/72/answer');
    expect(request.request.body).toEqual({ command: 'approve', ownerSaid: 'Утвердить' });
    request.flush(written, { status: 201, statusText: 'Created' });

    await expect(pending).resolves.toEqual({ ok: true, response: written });
  });

  it('a replay (200, Idempotent-Replayed) is a success', async () => {
    const pending = client.submit('team-console', 72, { command: 'approve', ownerSaid: 'Утвердить' });
    http
      .expectOne(answerUrl('team-console', 72))
      .flush(
        { ...written, replayed: false },
        { status: 200, statusText: 'OK', headers: { 'Idempotent-Replayed': 'true' } },
      );

    await expect(pending).resolves.toEqual({ ok: true, response: { ...written, replayed: true } });
  });

  it('an error is a failure, never a throw; an unreadable 2xx asks for a retry', async () => {
    const refused = client.submit('team-console', 72, { command: 'approve', ownerSaid: 'Утвердить' });
    http
      .expectOne(answerUrl('team-console', 72))
      .flush(
        { type: `${PROBLEM_TYPE_PREFIX}github-owner-mismatch`, title: 'x', status: 409 },
        { status: 409, statusText: 'Conflict' },
      );
    await expect(refused).resolves.toEqual({
      ok: false,
      failure: { kind: 'owner-mismatch', recovery: 'settings', retryAfter: null },
    });

    const odd = client.submit('team-console', 72, { command: 'approve', ownerSaid: 'Утвердить' });
    http.expectOne(answerUrl('team-console', 72)).flush('<html>', { status: 200, statusText: 'OK' });
    await expect(odd).resolves.toMatchObject({ ok: false, failure: { kind: 'unknown', recovery: 'retry' } });
  });

  it('encodes the slug into the path', () => {
    expect(answerUrl('a/b', 1)).toBe('/api/v1/projects/a%2Fb/issues/1/answer');
    expect(answerLookupUrl('a/b', 1)).toBe('/api/v1/projects/a%2Fb/issues/1/answer/lookup');
  });

  describe('lookup (#120)', () => {
    const request = { command: 'reject', text: 'рано', ownerSaid: 'Отклонить' } as const;

    it('posts the same answer plus how long ago it was first sent, whole milliseconds within the cap', async () => {
      const found = client.lookup('team-console', 72, request, 61_000.4);
      const read = http.expectOne(answerLookupUrl('team-console', 72));
      expect(read.request.method).toBe('POST');
      expect(read.request.body).toEqual({ ...request, sentAgoMs: 61_000 });
      read.flush({ answer: { ...written, command: 'reject' } });
      await expect(found).resolves.toEqual({
        ok: true,
        answer: { ...written, command: 'reject', replayed: true },
      });

      const capped = client.lookup('team-console', 72, request, 10 * ANSWER_LOOKUP_MAX_MS);
      const late = http.expectOne(answerLookupUrl('team-console', 72));
      expect((late.request.body as { sentAgoMs: number }).sentAgoMs).toBe(ANSWER_LOOKUP_MAX_MS);
      late.flush({ answer: null });
      await expect(capped).resolves.toEqual({ ok: true, answer: null });
    });

    it('a problem or an unreadable body is a failure, never a throw', async () => {
      const closed = client.lookup('team-console', 72, request, 61_000);
      http
        .expectOne(answerLookupUrl('team-console', 72))
        .flush(
          { type: `${PROBLEM_TYPE_PREFIX}issue-closed`, title: 'x', status: 409 },
          { status: 409, statusText: 'Conflict' },
        );
      await expect(closed).resolves.toEqual({
        ok: false,
        failure: { kind: 'issue-closed', recovery: 'refresh', retryAfter: null },
      });

      const odd = client.lookup('team-console', 72, request, 61_000);
      http.expectOne(answerLookupUrl('team-console', 72)).flush({ answer: { url: 'x' } });
      await expect(odd).resolves.toMatchObject({
        ok: false,
        failure: { kind: 'unknown', recovery: 'retry' },
      });
    });
  });
});
