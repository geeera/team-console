import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { GitHubConnectionStore } from '@console/entities/github-connection';
import { PROJECTS_URL, ProjectsStore } from '@console/entities/project';
import { PROBLEM_TYPE_PREFIX, type ProjectDto, type ProjectSetupDto } from '@shared/contracts';
import { AddProject, type AddJobState } from './add-project';

const STORIFY: ProjectDto = {
  slug: 'storify',
  repo: 'geeera/storify',
  displayName: 'storify',
  routineId: null,
  addedAt: '2026-10-05T12:00:00.000Z',
  archivedAt: null,
};

const SETUP: ProjectSetupDto = {
  appInstalled: 'ok',
  repoOwner: 'ok',
  projectYml: 'ok',
  events: 'never',
  lastEventAt: null,
  routineToken: 'missing',
  connection: { state: 'connected', login: 'geeera' },
  accessLostAt: null,
  ownerLanguage: 'ru',
  repoOwnerLogin: 'geeera',
};

const problem = (slug: string, status: number, extra: Record<string, unknown> = {}) => ({
  type: `${PROBLEM_TYPE_PREFIX}${slug}`,
  title: slug,
  status,
  ...extra,
});

describe('AddProject', () => {
  function setup() {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    return {
      adder: TestBed.inject(AddProject),
      http: TestBed.inject(HttpTestingController),
      projects: TestBed.inject(ProjectsStore),
    };
  }

  afterEach(() => {
    const http = TestBed.inject(HttpTestingController);
    // Syncing the connection from the setup answer may read it; not what these tests look at.
    http
      .match((request) => request.url.endsWith('/github/connection'))
      .forEach((request) => request.flush({}));
    http.verify();
  });

  it('posts the repository and puts the saved project in the list (the switcher shows it)', async () => {
    const { adder, http, projects } = setup();
    const result = adder.add('geeera/storify', 'storify');
    const request = http.expectOne(PROJECTS_URL);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ repo: 'geeera/storify' });
    request.flush(STORIFY);
    await expect(result).resolves.toEqual({ kind: 'added', slug: 'storify' });
    expect(projects.activeSlugs()).toEqual(['storify']);
  });

  it('maps a refusal by its type and step, nothing saved', async () => {
    const { adder, http, projects } = setup();
    const result = adder.add('geeera/no-yml', 'no-yml');
    http
      .expectOne(PROJECTS_URL)
      .flush(problem('project-yml-missing', 409, { step: 'project-yml' }), {
        status: 409,
        statusText: 'Conflict',
      });
    const answer = await result;
    expect(answer.kind).toBe('refused');
    expect(answer.kind === 'refused' && answer.outcome.kind).toBe('refused');
    expect(projects.activeSlugs()).toEqual([]);
  });

  it('notes a lost connection on 403 not connected', async () => {
    const { adder, http } = setup();
    const connection = TestBed.inject(GitHubConnectionStore);
    const noted = vi.spyOn(connection, 'noteNotConnected');
    const result = adder.add('geeera/storify', 'storify');
    http
      .expectOne(PROJECTS_URL)
      .flush(problem('github-owner-not-connected', 403), { status: 403, statusText: 'Forbidden' });
    await expect(result).resolves.toEqual({ kind: 'refused', outcome: { kind: 'not-connected' } });
    expect(noted).toHaveBeenCalled();
  });

  it('turns 409 project-exists into "already on the list" with its slug', async () => {
    const { adder, http } = setup();
    const result = adder.add('geeera/storify', 'storify');
    http
      .expectOne(PROJECTS_URL)
      .flush(problem('project-exists', 409), { status: 409, statusText: 'Conflict' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    http.expectOne(`${PROJECTS_URL}?include=archived`).flush([STORIFY]);
    await expect(result).resolves.toEqual({
      kind: 'refused',
      outcome: { kind: 'duplicate', slug: 'storify' },
    });
  });

  it('a job reports every attempt, with the setup steps after a save', async () => {
    const { adder, http } = setup();
    const settled: AddJobState[] = [];
    const job = adder.start('geeera/storify', 'storify', (state) => settled.push(state));
    expect(job.state()).toEqual({ kind: 'checking' });

    const run = job.run();
    expect(job.isRunning).toBe(true);
    http.expectOne(PROJECTS_URL).flush(STORIFY);
    await new Promise((resolve) => setTimeout(resolve, 0));
    http.expectOne('/api/v1/projects/storify/setup').flush(SETUP);
    const state = await run;

    expect(state.kind).toBe('added');
    expect(state.kind === 'added' && state.steps?.map((step) => step.state)).toEqual([
      'done',
      'done',
      'done',
      'waiting',
      'missing',
    ]);
    expect(settled).toEqual([state]);
  });

  it('keeps the add when the setup read after it fails: steps are unknown, not an error', async () => {
    const { adder, http } = setup();
    const job = adder.start('geeera/storify', 'storify', () => undefined);
    const run = job.run();
    http.expectOne(PROJECTS_URL).flush(STORIFY);
    await new Promise((resolve) => setTimeout(resolve, 0));
    http.expectOne('/api/v1/projects/storify/setup').flush(null, { status: 502, statusText: 'Bad Gateway' });
    await expect(run).resolves.toEqual({ kind: 'added', slug: 'storify', steps: null });
  });
});
