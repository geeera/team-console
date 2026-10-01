import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { ProjectSetupDto } from '@shared/contracts';
import {
  isProjectSetupDto,
  pendingSetupSteps,
  ProjectSetupApi,
  refusedSetupSteps,
  setupStepsOf,
  setupSummaryOf,
  setupUrlOf,
} from './project-setup';

const READY: ProjectSetupDto = {
  appInstalled: 'ok',
  repoOwner: 'ok',
  projectYml: 'ok',
  events: 'seen',
  lastEventAt: '2026-10-01T09:35:00.000Z',
  routineToken: 'present',
  connection: { state: 'connected', login: 'geeera' },
  accessLostAt: null,
  ownerLanguage: 'ru',
  repoOwnerLogin: 'geeera',
};

const states = (setup: ProjectSetupDto): string[] => setupStepsOf(setup).map((step) => step.state);

describe('setupStepsOf', () => {
  it('a ready project: five steps done', () => {
    expect(states(READY)).toEqual(['done', 'done', 'done', 'done', 'done']);
    expect(setupSummaryOf(setupStepsOf(READY))).toEqual({ left: 0, unknown: 0, done: 5, ready: true });
  });

  it('no event yet is "waiting", not "missing", and still keeps the project from ready', () => {
    const steps = setupStepsOf({ ...READY, events: 'never', lastEventAt: null });
    expect(steps[3]).toEqual({ id: 'events', state: 'waiting' });
    expect(setupSummaryOf(steps)).toMatchObject({ left: 1, ready: false });
  });

  it('app not installed: step 1 missing, steps 2–3 not checked, 4–5 as reported', () => {
    const steps = setupStepsOf({
      ...READY,
      appInstalled: 'missing',
      repoOwner: 'not-checked',
      projectYml: 'missing',
      routineToken: 'missing',
      installUrl: 'https://github.com/apps/team-console-dev/installations/new',
    });
    expect(steps).toEqual([
      { id: 'app', state: 'missing' },
      { id: 'owner', state: 'skipped', skippedBecause: 'previous' },
      { id: 'yml', state: 'skipped', skippedBecause: 'previous' },
      { id: 'events', state: 'done' },
      { id: 'routine', state: 'missing' },
    ]);
  });

  it('owner not checked because no account is connected says so', () => {
    const steps = setupStepsOf({
      ...READY,
      repoOwner: 'not-checked',
      connection: { state: 'not-connected' },
    });
    expect(steps[1]).toEqual({ id: 'owner', state: 'skipped', skippedBecause: 'not-connected' });
  });

  it('a mismatch is missing; per-step unknowns stay per step (#83)', () => {
    expect(states({ ...READY, repoOwner: 'mismatch' })).toEqual(['done', 'missing', 'done', 'done', 'done']);
    const unknown = setupStepsOf({
      ...READY,
      appInstalled: 'unknown',
      repoOwner: 'not-checked',
      projectYml: 'unknown',
    });
    expect(unknown.map((step) => step.state)).toEqual(['unknown', 'unknown', 'unknown', 'done', 'done']);
    expect(setupSummaryOf(unknown)).toMatchObject({ unknown: 3, ready: false });
  });
});

describe('refusedSetupSteps', () => {
  it('marks the refused step missing, the ones before done and the rest not checked', () => {
    expect(refusedSetupSteps('repo-owner')?.map((step) => step.state)).toEqual([
      'done',
      'missing',
      'skipped',
      'skipped',
      'skipped',
    ]);
    expect(refusedSetupSteps('app-installed')?.map((step) => step.state)).toEqual([
      'missing',
      'skipped',
      'skipped',
      'skipped',
      'skipped',
    ]);
    expect(refusedSetupSteps('project-yml')?.[2]).toEqual({ id: 'yml', state: 'missing' });
  });

  it('is null for a step that is not a GitHub check', () => {
    expect(refusedSetupSteps('unique')).toBeNull();
    expect(refusedSetupSteps(undefined)).toBeNull();
  });
});

describe('pendingSetupSteps', () => {
  it('is five steps checking, never ready', () => {
    expect(pendingSetupSteps().map((step) => step.state)).toEqual(Array(5).fill('pending'));
    expect(setupSummaryOf(pendingSetupSteps()).ready).toBe(false);
  });
});

describe('isProjectSetupDto', () => {
  it('accepts the Worker’s shape', () => {
    expect(isProjectSetupDto(READY)).toBe(true);
  });

  it('refuses an install link off github.com and unknown states', () => {
    expect(isProjectSetupDto({ ...READY, installUrl: 'https://evil.example/install' })).toBe(false);
    expect(isProjectSetupDto({ ...READY, appInstalled: 'maybe' })).toBe(false);
    expect(isProjectSetupDto({ ...READY, connection: { state: 'connected' } })).toBe(false);
    expect(isProjectSetupDto(null)).toBe(false);
  });
});

describe('ProjectSetupApi', () => {
  let http: HttpTestingController;
  let api: ProjectSetupApi;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    api = TestBed.inject(ProjectSetupApi);
  });

  afterEach(() => http.verify());

  it('reads the setup status; fresh adds ?fresh=1 to bypass the Worker cache', async () => {
    const cached = api.get('storify');
    const plain = http.expectOne((req) => req.url === setupUrlOf('storify'));
    expect(plain.request.params.has('fresh')).toBe(false);
    plain.flush(READY);
    await expect(cached).resolves.toEqual(READY);

    const fresh = api.get('storify', { fresh: true });
    const request = http.expectOne((req) => req.url === '/api/v1/projects/storify/setup');
    expect(request.request.urlWithParams).toBe('/api/v1/projects/storify/setup?fresh=1');
    request.flush(READY);
    await fresh;
  });

  it('rejects a body of the wrong shape', async () => {
    const result = api.get('storify');
    http.expectOne((req) => req.url === setupUrlOf('storify')).flush({ appInstalled: 'ok' });
    await expect(result).rejects.toThrow('unexpected response shape');
  });
});
