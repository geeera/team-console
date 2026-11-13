import { HttpHeaders, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { itemFixture } from './item.fixture';
import { freezeDaysOrDefault } from './item-queue';
import { decisionsUrl, itemUrl, ItemsApi, sprintFreezeUrl, sprintsUrl } from './items.api';
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

  it('records a decision with its key and reads a replay as replayed (#457)', async () => {
    const decision = { command: 'approve', text: '', askId: 4, reversesCommentId: null, via: 'web' } as const;
    const pending = api.decide('team-console', 7, decision, 'key-2');
    const request = http.expectOne(decisionsUrl('team-console', 7));
    expect(request.request.method).toBe('POST');
    expect(request.request.headers.get('Idempotency-Key')).toBe('key-2');
    expect(request.request.headers.has('If-Match')).toBe(false);
    expect(request.request.body).toEqual(decision);
    request.flush(
      { id: 3, ...decision, decidedAt: '2026-11-09T10:00:00.000Z', sourceUrl: null },
      { headers: { 'Idempotent-Replayed': 'true' } },
    );
    await expect(pending).resolves.toMatchObject({ ok: true, replayed: true, value: { id: 3 } });
  });

  it('names a sprint only when given a name (#457)', async () => {
    const sprint = { state: 'open', description: '', createdAt: 'x', closedAt: null };
    const named = api.createSprint('team-console', { dueOn: '2026-12-11', title: 'Checkout' }, 'k');
    const first = http.expectOne(sprintsUrl('team-console'));
    expect(first.request.body).toEqual({ dueOn: '2026-12-11', title: 'Checkout' });
    first.flush({ ...sprint, number: 3, title: 'Checkout', dueOn: '2026-12-11' });
    await expect(named).resolves.toMatchObject({ ok: true, value: { title: 'Checkout' } });
    const unnamed = api.createSprint('team-console', { dueOn: '2026-12-25', title: null }, 'k2');
    const second = http.expectOne(sprintsUrl('team-console'));
    expect(second.request.body).toEqual({ dueOn: '2026-12-25' });
    second.flush({ ...sprint, number: 4, title: 'Sprint 04', dueOn: '2026-12-25' });
    await unnamed;
  });

  it('reads the sprint list with its open counts, and refuses one without them (#561)', async () => {
    const sprint = { number: 4, title: 'Sprint 04', dueOn: null, state: 'open', description: '', createdAt: 'x', closedAt: null };
    const counted = api.sprintList('team-console');
    http.expectOne(sprintsUrl('team-console')).flush({ sprints: [{ ...sprint, openCount: 3 }], backlogOpenCount: 7 });
    await expect(counted).resolves.toMatchObject({ ok: true, value: { backlogOpenCount: 7, sprints: [{ openCount: 3 }] } });
    const uncounted = api.sprintList('team-console');
    http.expectOne(sprintsUrl('team-console')).flush({ sprints: [sprint], backlogOpenCount: 7 });
    await expect(uncounted).resolves.toEqual({ ok: false, reason: 'error' });
  });

  it("reads the project's freeze days and falls back to the plugin's default (#457)", async () => {
    const read = api.freezeDays('team-console');
    http.expectOne(sprintFreezeUrl('team-console')).flush({ freezeDays: 3 });
    const days = await read;
    expect(days).toEqual({ ok: true, value: 3 });
    expect(freezeDaysOrDefault(days)).toBe(3);
    const odd = api.freezeDays('team-console');
    http.expectOne(sprintFreezeUrl('team-console')).flush({ freezeDays: 99 });
    expect(freezeDaysOrDefault(await odd)).toBe(2);
    const failed = api.freezeDays('team-console');
    http.expectOne(sprintFreezeUrl('team-console')).error(new ProgressEvent('error'), { status: 0 });
    expect(freezeDaysOrDefault(await failed)).toBe(2);
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

  it('reads a whole item list past one page, and refuses a partial one (#556)', async () => {
    const page = (from: number, count: number) =>
      Array.from({ length: count }, (_, n) => itemFixture({ number: from + n, sprint: null }));
    const whole = api.items('team-console', { state: 'open', sprint: 'none' }, true);
    http
      .expectOne((request) => request.url.endsWith('/items') && !request.params.has('after'))
      .flush({ items: page(1, 100), next: 100 });
    await Promise.resolve();
    const last = http.expectOne((request) => request.params.get('after') === '100');
    expect(last.request.params.get('sprint')).toBe('none');
    last.flush({ items: page(101, 50), next: null });
    const read = await whole;
    expect(read.ok && read.value.length).toBe(150);

    const endless = api.items('team-console', {}, true);
    for (let n = 0; n < 20; n += 1) {
      await Promise.resolve();
      http.expectOne((request) => request.url.endsWith('/items')).flush({ items: page(n + 1, 1), next: n + 1 });
    }
    await expect(endless).resolves.toEqual({ ok: false, reason: 'error' });
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

  it('reads every tracker slug from the one table, before the status (#457)', () => {
    expect(trackerFailureOf(problem(409, 'item-version-required')).kind).toBe('conflict');
    expect(trackerFailureOf(problem(409, 'ask-imported')).kind).toBe('gone');
    // decision-command is a 422 that names the `command` field (#470 item 3); kept so the screen can word it
    // apart from the other `gone` problems, which never name one.
    expect(trackerFailureOf(problem(422, 'decision-command', { field: 'command' }))).toMatchObject({
      kind: 'gone',
      field: 'command',
    });
    expect(trackerFailureOf(problem(409, 'item-closed'))).toMatchObject({ kind: 'gone', field: null });
    expect(trackerFailureOf(problem(404, 'project-not-found')).kind).toBe('not-found');
    expect(trackerFailureOf(problem(409, 'item-not-found')).kind).toBe('not-found');
    // An unlisted slug falls to its status; `Object.prototype` names are never slugs.
    expect(trackerFailureOf(problem(422, 'decision-invalid', { field: 'text' })).kind).toBe('invalid');
    expect(trackerFailureOf(problem(500, 'constructor')).kind).toBe('unknown');
    expect(trackerFailureOf(problem(500, 'toString')).kind).toBe('unknown');
  });
});
