import { HttpErrorResponse, HttpHeaders, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { problemTypeOf } from '@shared/contracts';
import { TimeoutError } from 'rxjs';
import { jobFailureKeyOf, jobFailureOf, type JobFailureKind } from './job-failure';
import { JOB_FIXTURE_IDS, jobEventFixture, jobFixture, queuedJobFixture } from './job.fixture';
import { JOB_EVENTS_PAGE_LIMIT, JOBS_PAGE_LIMIT, JobsApi } from './jobs.api';

const JOBS = '/api/v1/projects/team-console/jobs';

function problem(status: number, type: string): HttpErrorResponse {
  return new HttpErrorResponse({
    status,
    error: { type: problemTypeOf(type), title: 'x', status },
    headers: new HttpHeaders({ 'Content-Type': 'application/problem+json' }),
    url: JOBS,
  });
}

describe('JobsApi', () => {
  function setup() {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    return { api: TestBed.inject(JobsApi), http: TestBed.inject(HttpTestingController) };
  }

  it("reads the project's newest jobs, and refuses an answer of the wrong shape", async () => {
    const { api, http } = setup();
    const read = api.list('team-console');
    http
      .expectOne(`${JOBS}?limit=${String(JOBS_PAGE_LIMIT)}`)
      .flush({ jobs: [jobFixture()], nextCursor: null });
    expect(await read).toEqual({ ok: true, value: { jobs: [jobFixture()], nextCursor: null } });

    const malformed = api.list('team-console');
    http
      .expectOne(`${JOBS}?limit=${String(JOBS_PAGE_LIMIT)}`)
      .flush({ jobs: [{ ...jobFixture(), state: 'paused' }] });
    expect(await malformed).toEqual({ ok: false, failure: { kind: 'error', slug: null } });
  });

  it('encodes the slug and the job id into the path', async () => {
    const { api, http } = setup();
    const read = api.events('a/b', JOB_FIXTURE_IDS.first, 7);
    http
      .expectOne(
        `/api/v1/projects/a%2Fb/jobs/${JOB_FIXTURE_IDS.first}/events?after=7&limit=${String(JOB_EVENTS_PAGE_LIMIT)}`,
      )
      .flush({ events: [jobEventFixture(8)], nextCursor: null });
    expect(await read).toEqual({ ok: true, value: { events: [jobEventFixture(8)], nextCursor: null } });
  });

  it('posts Run now with the kind only and answers the queued job', async () => {
    const { api, http } = setup();
    const queued = api.enqueue('team-console', 'slot-dev');
    const request = http.expectOne(JOBS);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ kind: 'slot-dev' });
    request.flush(queuedJobFixture(), { status: 201, statusText: 'Created' });
    expect(await queued).toEqual({ ok: true, value: queuedJobFixture() });
  });

  it.each<[string, number, string, JobFailureKind, string]>([
    ['a member (Run now is the owner’s)', 403, 'owner-only', 'forbidden', 'jobs.err.forbidden'],
    ['another account’s or a missing project', 404, 'project-not-found', 'not-found', 'jobs.err.notFound'],
    ['a project still on GitHub', 409, 'tracker-not-cut-over', 'not-cut-over', 'jobs.err.notCutOver'],
    ['a slot job already live', 409, 'job-exists', 'exists', 'jobs.err.exists'],
    ['a malformed request', 422, 'job-invalid', 'invalid', 'jobs.err.invalid'],
    ['too many requests', 429, 'rate-limited', 'rate-limited', 'jobs.err.rateLimited'],
    ['another conflict', 409, 'something-else', 'error', 'jobs.err.error'],
    ['a server error', 500, 'internal', 'error', 'jobs.err.error'],
  ])('words the refusal of %s', async (_name, status, type, kind, key) => {
    const { api, http } = setup();
    const queued = api.enqueue('team-console', 'slot-pm');
    http
      .expectOne(JOBS)
      .flush(
        { type: problemTypeOf(type), title: 'x', status },
        { status, statusText: 'x', headers: { 'Content-Type': 'application/problem+json' } },
      );
    const result = await queued;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toEqual({ kind, slug: type });
      expect(jobFailureKeyOf(result.failure)).toBe(key);
    }
  });
});

describe('jobFailureOf', () => {
  it('tells a timeout, no network and an unknown throw apart', () => {
    expect(jobFailureOf(new TimeoutError())).toEqual({ kind: 'timeout', slug: null });
    expect(jobFailureOf(new HttpErrorResponse({ status: 0, url: JOBS }))).toMatchObject({ kind: 'offline' });
    expect(jobFailureOf(new Error('boom'))).toEqual({ kind: 'error', slug: null });
  });

  it('reads an Access login page as an expired session', () => {
    const failure = jobFailureOf(
      new HttpErrorResponse({
        status: 401,
        error: '<html>login</html>',
        headers: new HttpHeaders({ 'Content-Type': 'text/html' }),
        url: JOBS,
      }),
    );
    expect(failure.kind).toBe('session-expired');
    expect(jobFailureKeyOf(failure)).toBe('jobs.err.sessionExpired');
  });

  it('branches on the slug, never on the title', () => {
    expect(jobFailureOf(problem(409, 'job-exists')).kind).toBe('exists');
    expect(jobFailureOf(problem(413, 'payload-too-large')).kind).toBe('invalid');
  });
});
