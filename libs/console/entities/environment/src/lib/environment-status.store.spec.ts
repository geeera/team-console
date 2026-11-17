import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ErrorHandler } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ENVIRONMENT_STATUS_URL, type EnvironmentStatusDto } from '@shared/environment';
import { EnvironmentStatusStore, ProjectEnvironmentStatuses } from './environment-status.store';

const ANSWER: EnvironmentStatusDto = {
  environment: 'dev',
  items: [
    { id: 'api/OWNER_EMAIL', status: 'set', optional: false },
    { id: 'api/VAPID_PRIVATE_KEY', status: 'missing', optional: false },
  ],
};

describe('EnvironmentStatusStore', () => {
  let store: EnvironmentStatusStore;
  let http: HttpTestingController;
  const handleError = vi.fn();

  beforeEach(() => {
    handleError.mockReset();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ErrorHandler, useValue: { handleError } },
      ],
    });
    store = TestBed.inject(EnvironmentStatusStore);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function answer(
    respond: (request: ReturnType<HttpTestingController['expectOne']>) => void,
  ): Promise<void> {
    const pending = store.load();
    await Promise.resolve();
    respond(http.expectOne(ENVIRONMENT_STATUS_URL));
    await pending;
  }

  it('keeps the answer and its time', async () => {
    await answer((request) => request.flush(ANSWER));
    expect(store.state()).toBe('ready');
    expect(store.statusOf('api/VAPID_PRIVATE_KEY')).toBe('missing');
    expect(store.checkedAt()).not.toBeNull();
  });

  it('keeps the last answer through an offline re-check', async () => {
    await answer((request) => request.flush(ANSWER));
    await answer((request) => request.error(new ProgressEvent('error'), { status: 0 }));
    expect(store.state()).toBe('error');
    expect(store.problem()).toEqual({ kind: 'offline' });
    expect(store.snapshot()).toEqual(ANSWER);
  });

  it('drops everything on 403: nothing stays on screen for a session that is not the owner', async () => {
    await answer((request) => request.flush(ANSWER));
    await answer((request) =>
      request.flush(
        { type: 'https://team-console.dev/problems/owner-only', title: 'Forbidden', status: 403 },
        {
          status: 403,
          statusText: 'Forbidden',
        },
      ),
    );
    expect(store.problem()).toEqual({ kind: 'forbidden' });
    expect(store.snapshot()).toBeNull();
  });

  it('dates a 429 by its Retry-After', async () => {
    const before = Date.now();
    await answer((request) =>
      request.flush(null, { status: 429, statusText: 'Too Many', headers: { 'Retry-After': '120' } }),
    );
    const problem = store.problem();
    expect(problem?.kind).toBe('rate');
    if (problem?.kind === 'rate') {
      expect(Date.parse(problem.retryAt)).toBeGreaterThanOrEqual(before + 120_000);
    }
  });

  it('refuses an answer of the wrong shape without reporting it as a crash', async () => {
    await answer((request) => request.flush({ environment: 'dev', items: [{ id: 'x', status: 'leak' }] }));
    expect(store.state()).toBe('error');
    expect(store.problem()).toEqual({ kind: 'failed' });
    expect(handleError).not.toHaveBeenCalled();
  });

  it('refuses a console answer that carries a project row (#750)', async () => {
    await answer((request) =>
      request.flush({
        environment: 'production',
        items: [{ id: 'project/storify/ROUTINE_TOKEN_STORIFY', status: 'set', optional: false }],
      }),
    );
    expect(store.problem()).toEqual({ kind: 'failed' });
    expect(store.snapshot()).toBeNull();
  });
});

describe('ProjectEnvironmentStatuses (#750)', () => {
  let statuses: ProjectEnvironmentStatuses;
  let http: HttpTestingController;
  const PROJECT_ANSWER: EnvironmentStatusDto = {
    environment: 'production',
    items: [{ id: 'project/storify/ROUTINE_TOKEN_STORIFY', status: 'missing', optional: false }],
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    statuses = TestBed.inject(ProjectEnvironmentStatuses);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function answerFor(
    slug: string,
    respond: (request: ReturnType<HttpTestingController['expectOne']>) => void,
  ): Promise<void> {
    const pending = statuses.of(slug).load();
    await Promise.resolve();
    respond(http.expectOne(`${ENVIRONMENT_STATUS_URL}?project=${slug}`));
    await pending;
  }

  it('asks for one project only and keeps one status per project for the session', async () => {
    await answerFor('storify', (request) => request.flush(PROJECT_ANSWER));
    expect(statuses.of('storify')).toBe(statuses.of('storify'));
    expect(statuses.of('storify').statusOf('project/storify/ROUTINE_TOKEN_STORIFY')).toBe('missing');
    expect(statuses.of('other').state()).toBe('idle');
  });

  it('refuses an answer with another project’s rows', async () => {
    await answerFor('other', (request) => request.flush(PROJECT_ANSWER));
    expect(statuses.of('other').problem()).toEqual({ kind: 'failed' });
    expect(statuses.of('other').snapshot()).toBeNull();
  });

  it('drops the snapshot on 404: archived, unknown or out of scope read the same', async () => {
    await answerFor('storify', (request) => request.flush(PROJECT_ANSWER));
    await answerFor('storify', (request) =>
      request.flush(
        { type: 'https://team-console.dev/problems/project-not-found', title: 'Not found', status: 404 },
        { status: 404, statusText: 'Not Found' },
      ),
    );
    expect(statuses.of('storify').problem()).toEqual({ kind: 'not-found' });
    expect(statuses.of('storify').snapshot()).toBeNull();
  });
});
