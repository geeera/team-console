import { HttpErrorResponse, HttpHeaders, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { isOrchestrationDto as contractGuard, problemTypeOf } from '@shared/contracts';
import { TimeoutError } from 'rxjs';
import { OrchestrationApi, orchestrationUrl } from './orchestration.api';
import {
  orchestrationFailureKeyOf,
  orchestrationFailureOf,
  type OrchestrationFailureKind,
} from './orchestration-failure';
import { idleOrchestrationFixture, runningOrchestrationFixture } from './orchestration.fixture';
import { isOrchestrationDto, isRunActive } from './orchestration.model';

const URL = '/api/v1/projects/team-console/orchestration';

function problem(status: number, type: string | null): HttpErrorResponse {
  return new HttpErrorResponse({
    status,
    error: type === null ? 'Bad gateway' : { type: problemTypeOf(type), title: 'x', status },
    headers: new HttpHeaders({ 'Content-Type': 'application/problem+json' }),
    url: URL,
  });
}

describe('OrchestrationApi', () => {
  function setup() {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    return { api: TestBed.inject(OrchestrationApi), http: TestBed.inject(HttpTestingController) };
  }

  it('encodes the slug into the path', () => {
    expect(orchestrationUrl('a/b c')).toBe('/api/v1/projects/a%2Fb%20c/orchestration');
  });

  it('reads the run, and refuses an answer of the wrong shape', async () => {
    const { api, http } = setup();
    const read = api.get('team-console');
    http.expectOne({ method: 'GET', url: URL }).flush(runningOrchestrationFixture());
    expect(await read).toEqual({ ok: true, value: runningOrchestrationFixture() });

    const malformed = api.get('team-console');
    // An idle state with a run id is not a DTO the contract accepts.
    http.expectOne({ method: 'GET', url: URL }).flush({ ...runningOrchestrationFixture(), state: 'idle' });
    expect(await malformed).toEqual({ ok: false, failure: { kind: 'error', slug: null } });
    http.verify();
  });

  it('starts with an empty body and answers the run Start made', async () => {
    const { api, http } = setup();
    const started = api.start('team-console');
    const request = http.expectOne({ method: 'POST', url: `${URL}/start` });
    expect(request.request.body).toEqual({});
    request.flush(runningOrchestrationFixture(), { status: 201, statusText: 'Created' });
    expect(await started).toEqual({ ok: true, value: runningOrchestrationFixture() });
    http.verify();
  });

  it('stops with an empty body; a second Stop is the idle refusal', async () => {
    const { api, http } = setup();
    const stopped = api.stop('team-console');
    const request = http.expectOne({ method: 'POST', url: `${URL}/stop` });
    expect(request.request.body).toEqual({});
    request.flush(idleOrchestrationFixture());
    expect(await stopped).toEqual({ ok: true, value: idleOrchestrationFixture() });

    const again = api.stop('team-console');
    http
      .expectOne({ method: 'POST', url: `${URL}/stop` })
      .flush(
        { type: problemTypeOf('orchestration-idle'), title: 'Conflict', status: 409 },
        { status: 409, statusText: 'Conflict' },
      );
    expect(await again).toEqual({ ok: false, failure: { kind: 'idle', slug: 'orchestration-idle' } });
    http.verify();
  });
});

describe('orchestrationFailureOf', () => {
  it.each<[string, HttpErrorResponse, OrchestrationFailureKind]>([
    ['a run already on', problem(409, 'orchestration-active'), 'active'],
    ['no run to stop', problem(409, 'orchestration-idle'), 'idle'],
    ['development paused', problem(409, 'run-paused'), 'paused'],
    ['another orchestrator job live', problem(409, 'job-exists'), 'exists'],
    ['another 409 slug', problem(409, 'tracker-not-cut-over'), 'error'],
    ['a 409 that is not our problem', problem(409, null), 'error'],
    ['owner only', problem(403, 'owner-only'), 'forbidden'],
    ['not found', problem(404, 'project-not-found'), 'not-found'],
    ['invalid', problem(422, 'orchestration-invalid'), 'invalid'],
    ['too large', problem(413, 'payload-too-large'), 'invalid'],
    ['rate limited', problem(429, 'rate-limited'), 'rate-limited'],
    ['no answer', new HttpErrorResponse({ status: 0, url: URL }), 'offline'],
    ['a server error', problem(500, null), 'error'],
  ])('%s', (_name, error, kind) => {
    expect(orchestrationFailureOf(error).kind).toBe(kind);
  });

  it('reads a timeout and a non-HTTP error', () => {
    expect(orchestrationFailureOf(new TimeoutError())).toEqual({ kind: 'timeout', slug: null });
    expect(orchestrationFailureOf(new Error('boom'))).toEqual({ kind: 'error', slug: null });
  });

  it('reads an Access login page as an expired session', () => {
    const login = new HttpErrorResponse({
      status: 401,
      error: '<html>login</html>',
      headers: new HttpHeaders({ 'Content-Type': 'text/html' }),
      url: URL,
    });
    expect(orchestrationFailureOf(login).kind).toBe('session-expired');
  });

  it('has an orchestration.err key for every kind', () => {
    const kinds: readonly OrchestrationFailureKind[] = [
      'active',
      'idle',
      'paused',
      'exists',
      'forbidden',
      'not-found',
      'invalid',
      'rate-limited',
      'offline',
      'timeout',
      'session-expired',
      'error',
    ];
    const keys = kinds.map((kind) => orchestrationFailureKeyOf({ kind, slug: null }));
    expect(new Set(keys).size).toBe(kinds.length);
    expect(keys.every((key) => key.startsWith('orchestration.err.'))).toBe(true);
  });
});

describe('the model', () => {
  it('re-exports the contract guard rather than a copy', () => {
    expect(isOrchestrationDto).toBe(contractGuard);
  });

  it.each([
    ['idle', idleOrchestrationFixture(), false],
    ['running', runningOrchestrationFixture(), true],
    ['waiting for the owner', runningOrchestrationFixture({ state: 'waiting-owner', liveStepId: null }), true],
    ['stopping', runningOrchestrationFixture({ state: 'stopping' }), true],
  ])('a run %s is active: %s', (_name, run, active) => {
    expect(isRunActive(run)).toBe(active);
  });
});
