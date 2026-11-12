import { HttpErrorResponse, HttpHeaders, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { OWNER_ACCOUNT_ID, problemTypeOf } from '@shared/contracts';
import { TimeoutError } from 'rxjs';
import { runnerFailureKeyOf, runnerFailureOf } from './runner-failure';
import { RUNNER_FIXTURE_IDS, runnerFixture } from './runner.fixture';
import { RunnersApi } from './runners.api';

const RUNNERS = `/api/v1/accounts/${OWNER_ACCOUNT_ID}/runners`;
const RELEASE = { version: '0.3.0', minimumVersion: '0.2.0' };

function problem(status: number, type: string, extra: Record<string, unknown> = {}): HttpErrorResponse {
  return new HttpErrorResponse({
    status,
    error: { type: problemTypeOf(type), title: 'x', status, ...extra },
    headers: new HttpHeaders({ 'Content-Type': 'application/problem+json' }),
    url: '/api/v1/x',
  });
}

describe('RunnersApi', () => {
  function setup() {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    return { api: TestBed.inject(RunnersApi), http: TestBed.inject(HttpTestingController) };
  }

  it("reads the caller's accounts", async () => {
    const { api, http } = setup();
    const read = api.accounts();
    http
      .expectOne('/api/v1/accounts')
      .flush({ accounts: [{ id: OWNER_ACCOUNT_ID, slug: 'owner', name: 'Owner', role: 'owner' }] });
    expect(await read).toEqual({
      ok: true,
      value: [{ id: OWNER_ACCOUNT_ID, slug: 'owner', name: 'Owner', role: 'owner' }],
    });
  });

  it('lists the runners with the release, and refuses an answer of the wrong shape', async () => {
    const { api, http } = setup();
    const read = api.list(OWNER_ACCOUNT_ID);
    http.expectOne(RUNNERS).flush({ runners: [runnerFixture()], pendingEnrolments: [], release: RELEASE });
    expect(await read).toEqual({ ok: true, value: { runners: [runnerFixture()], pendingEnrolments: [], release: RELEASE } });

    const malformed = api.list(OWNER_ACCOUNT_ID);
    // A runner without `belowMinimum` (an older Worker) is not shown as if it met the minimum.
    const { belowMinimum: _dropped, ...older } = runnerFixture();
    http.expectOne(RUNNERS).flush({ runners: [older], pendingEnrolments: [], release: RELEASE });
    expect(await malformed).toEqual({ ok: false, failure: { kind: 'error', slug: null, field: null } });
  });

  it('posts the enrolment code request with the name and the projects only', async () => {
    const { api, http } = setup();
    const created = api.createEnrolmentCode(OWNER_ACCOUNT_ID, { name: 'Mac', allowedProjects: ['team-console'] });
    const request = http.expectOne(`${RUNNERS}/enrolment-code`);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ name: 'Mac', allowedProjects: ['team-console'] });
    const dto = {
      code: `tce_${'a'.repeat(43)}`,
      expiresAt: '2026-11-11T10:10:00.000Z',
      apiUrl: 'http://localhost:8787',
      audience: 'team-console:local',
      name: 'Mac',
      allowedProjects: ['team-console'],
    };
    request.flush(dto, { status: 201, statusText: 'Created' });
    expect(await created).toEqual({ ok: true, value: dto });
  });

  it('patches the allowed projects and posts a revoke, each answered with the runner', async () => {
    const { api, http } = setup();
    const patched = api.setAllowedProjects(OWNER_ACCOUNT_ID, RUNNER_FIXTURE_IDS.mac, []);
    const patch = http.expectOne(`${RUNNERS}/${RUNNER_FIXTURE_IDS.mac}`);
    expect([patch.request.method, patch.request.body]).toEqual(['PATCH', { allowedProjects: [] }]);
    patch.flush(runnerFixture({ allowedProjects: [] }));
    expect(await patched).toMatchObject({ ok: true, value: { allowedProjects: [] } });

    const revoked = api.revoke(OWNER_ACCOUNT_ID, RUNNER_FIXTURE_IDS.mac);
    const post = http.expectOne(`${RUNNERS}/${RUNNER_FIXTURE_IDS.mac}/revoke`);
    expect(post.request.method).toBe('POST');
    post.flush(problem(409, 'runner-revoked').error, { status: 409, statusText: 'Conflict' });
    expect(await revoked).toEqual({ ok: false, failure: { kind: 'revoked', slug: 'runner-revoked', field: null } });
  });

  // #492
  it('posts a clear-suspect answered with the runner, and a withdraw answered with 204', async () => {
    const { api, http } = setup();
    const cleared = api.clearSuspect(OWNER_ACCOUNT_ID, RUNNER_FIXTURE_IDS.mac);
    const clear = http.expectOne(`${RUNNERS}/${RUNNER_FIXTURE_IDS.mac}/clear-suspect`);
    expect(clear.request.method).toBe('POST');
    clear.flush(runnerFixture({ suspect: null }));
    expect(await cleared).toMatchObject({ ok: true, value: { suspect: null } });

    const id = 'a1'.repeat(32);
    const withdrawn = api.withdrawEnrolment(OWNER_ACCOUNT_ID, id);
    const withdraw = http.expectOne(`${RUNNERS}/enrolment-codes/${id}/withdraw`);
    expect(withdraw.request.method).toBe('POST');
    withdraw.flush(null, { status: 204, statusText: 'No Content' });
    expect(await withdrawn).toEqual({ ok: true, value: null });

    const gone = api.withdrawEnrolment(OWNER_ACCOUNT_ID, id);
    http
      .expectOne(`${RUNNERS}/enrolment-codes/${id}/withdraw`)
      .flush(problem(404, 'enrolment-not-found').error, { status: 404, statusText: 'Not Found' });
    expect(await gone).toEqual({ ok: false, failure: { kind: 'not-found', slug: 'enrolment-not-found', field: null } });
  });

  it('reads and writes placement per account and per project; null clears with a JSON body', async () => {
    const { api, http } = setup();
    const dto = { policy: null, effective: { mode: 'any' } };
    const account = api.policy({ kind: 'account', accountId: OWNER_ACCOUNT_ID });
    http.expectOne(`/api/v1/accounts/${OWNER_ACCOUNT_ID}/runner-policy`).flush(dto);
    expect(await account).toEqual({ ok: true, value: dto });

    const pinned = { mode: 'pinned', runner: RUNNER_FIXTURE_IDS.mac } as const;
    const set = api.setPolicy({ kind: 'project', slug: 'team console' }, pinned);
    const put = http.expectOne('/api/v1/projects/team%20console/runner-policy');
    expect(put.request.method).toBe('PUT');
    expect(put.request.headers.get('Content-Type')).toBe('application/json');
    expect(JSON.parse(put.request.body as string)).toEqual(pinned);
    put.flush({ policy: pinned, effective: pinned });
    expect(await set).toEqual({ ok: true, value: { policy: pinned, effective: pinned } });

    const cleared = api.setPolicy({ kind: 'project', slug: 'storify' }, null);
    const clear = http.expectOne('/api/v1/projects/storify/runner-policy');
    expect(clear.request.body).toBe('null');
    clear.flush(problem(422, 'runner-policy-invalid', { field: 'runner' }).error, {
      status: 422,
      statusText: 'Unprocessable',
    });
    expect(await cleared).toEqual({
      ok: false,
      failure: { kind: 'invalid', slug: 'runner-policy-invalid', field: 'runner' },
    });
  });

  it('reports a dropped connection as offline', async () => {
    const { api, http } = setup();
    const read = api.list(OWNER_ACCOUNT_ID);
    http.expectOne(RUNNERS).error(new ProgressEvent('error'), { status: 0 });
    expect(await read).toMatchObject({ ok: false, failure: { kind: 'offline' } });
  });
});

describe('runnerFailureOf', () => {
  it.each([
    [problem(403, 'account-owner-only'), 'forbidden'],
    [problem(404, 'runner-not-found'), 'not-found'],
    [problem(404, 'account-not-found'), 'not-found'],
    [problem(409, 'runner-revoked'), 'revoked'],
    [problem(409, 'runner-not-suspect'), 'not-suspect'],
    [problem(409, 'something-else'), 'error'],
    [problem(422, 'allowed-projects-invalid', { field: 'allowedProjects' }), 'invalid'],
    [problem(413, 'too-large'), 'invalid'],
    [problem(429, 'rate-limited'), 'rate-limited'],
    [problem(500, 'internal'), 'error'],
  ])('maps %s', (error, kind) => {
    expect(runnerFailureOf(error).kind).toBe(kind);
  });

  it('maps a timeout and a non-HTTP error', () => {
    expect(runnerFailureOf(new TimeoutError()).kind).toBe('timeout');
    expect(runnerFailureOf(new Error('boom')).kind).toBe('error');
  });

  it('reads an Access redirect as an expired session, not as offline', () => {
    const redirect = new HttpErrorResponse({ status: 0, url: 'https://team.cloudflareaccess.com/cdn-cgi/access/login' });
    expect(runnerFailureOf(redirect).kind).toBe('session-expired');
  });
});

describe('runnerFailureKeyOf', () => {
  it('words every refusal, a 422 by its slug and field', () => {
    const of = (kind: Parameters<typeof runnerFailureKeyOf>[0]['kind'], slug: string | null = null, field: string | null = null) =>
      runnerFailureKeyOf({ kind, slug, field });
    expect(of('invalid', 'allowed-projects-invalid', 'allowedProjects')).toBe('runners.err.allowedProjects');
    expect(of('invalid', 'runner-policy-invalid', 'runner')).toBe('runners.err.policyRunner');
    expect(of('invalid', 'runner-policy-invalid', 'fallback')).toBe('runners.err.policy');
    expect(of('invalid', 'enrolment-code-invalid-input', 'name')).toBe('runners.err.invalid');
    expect(of('forbidden')).toBe('runners.err.forbidden');
    expect(of('not-found')).toBe('runners.err.notFound');
    expect(of('not-found', 'enrolment-not-found')).toBe('runners.err.enrolmentGone');
    expect(of('not-suspect', 'runner-not-suspect')).toBe('runners.err.notSuspect');
    expect(of('session-expired')).toBe('runners.err.sessionExpired');
    expect(of('rate-limited')).toBe('runners.err.rateLimited');
  });
});
