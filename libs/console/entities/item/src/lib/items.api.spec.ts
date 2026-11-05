import { HttpHeaders, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { itemFixture } from './item.fixture';
import { itemUrl, ItemsApi } from './items.api';
import { trackerFailureOf } from './tracker-failure';
import { HttpErrorResponse } from '@angular/common/http';

const problem = (status: number, type: string, extra: Record<string, unknown> = {}) =>
  new HttpErrorResponse({
    status,
    error: { type: `https://team-console/problems/${type}`, title: type, status, ...extra },
    headers: new HttpHeaders({ 'Content-Type': 'application/problem+json' }),
  });

describe('ItemsApi', () => {
  let api: ItemsApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    api = TestBed.inject(ItemsApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('sends If-Match with the version read and the caller’s idempotency key', async () => {
    const pending = api.update('team-console', 7, 2, { status: 'qa' }, 'key-1');
    const request = http.expectOne(itemUrl('team-console', 7));
    expect(request.request.method).toBe('PATCH');
    expect(request.request.headers.get('If-Match')).toBe('"2"');
    expect(request.request.headers.get('Idempotency-Key')).toBe('key-1');
    expect(request.request.body).toEqual({ status: 'qa' });
    request.flush(itemFixture({ status: 'qa', version: 3 }), { headers: { 'Idempotent-Replayed': 'true' } });
    await expect(pending).resolves.toMatchObject({ ok: true, replayed: true, value: { version: 3 } });
  });

  it('reads 404 as not found and a dropped request as offline', async () => {
    const missing = api.item('team-console', 999);
    http
      .expectOne(itemUrl('team-console', 999))
      .flush({ type: 'x', title: 'x', status: 404 }, { status: 404, statusText: 'Not Found' });
    await expect(missing).resolves.toEqual({ ok: false, reason: 'not-found' });
    const dropped = api.item('team-console', 7);
    http.expectOne(itemUrl('team-console', 7)).error(new ProgressEvent('error'), { status: 0 });
    await expect(dropped).resolves.toEqual({ ok: false, reason: 'offline' });
  });

  it('pages a cursor list until next is null', async () => {
    const pending = api.events('team-console', 7);
    const first = http.expectOne(
      (request) => request.url.endsWith('/events') && !request.params.has('after'),
    );
    first.flush({
      events: [
        {
          id: 1,
          at: 'x',
          actor: { kind: 'owner', name: 'owner' },
          kind: 'created',
          before: null,
          after: null,
        },
      ],
      next: 1,
    });
    await Promise.resolve();
    const second = http.expectOne((request) => request.params.get('after') === '1');
    second.flush({ events: [], next: null });
    await expect(pending).resolves.toMatchObject({ ok: true, value: [{ id: 1 }] });
  });
});

describe('trackerFailureOf', () => {
  it('branches on the status and the problem slug', () => {
    expect(trackerFailureOf(problem(412, 'item-version')).kind).toBe('conflict');
    expect(trackerFailureOf(problem(409, 'item-changed')).kind).toBe('conflict');
    expect(trackerFailureOf(problem(409, 'ask-not-open')).kind).toBe('gone');
    expect(trackerFailureOf(problem(403, 'owner-only')).kind).toBe('forbidden');
    expect(trackerFailureOf(problem(422, 'item-invalid', { field: 'title' }))).toMatchObject({
      kind: 'invalid',
      field: 'title',
    });
    expect(trackerFailureOf(problem(409, 'idempotency-in-flight')).kind).toBe('in-flight');
    expect(trackerFailureOf(new HttpErrorResponse({ status: 0 })).kind).toBe('network');
    expect(trackerFailureOf(new Error('boom')).kind).toBe('unknown');
  });
});
