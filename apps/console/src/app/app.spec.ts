import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationInitStatus } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { NEEDS_YOU_URL, PROJECTS_URL, ProjectsStore } from '@console/entities/project';
import { provideAppConfig } from '@console/shared/config';
import { provideConsoleI18n } from '@console/shared/i18n';
import {
  emptyPersistedState,
  memoryPersistedStateStorage,
  PERSISTED_STATE_STORAGE,
  PersistedStateStore,
} from '@console/shared/persisted-state';
import { ProjectDto } from '@shared/contracts';
import { App } from './app';
import { appRoutes } from './app.routes';
import { projectExists } from './shell.guards';

const project = (slug: string, archivedAt: string | null = null): ProjectDto => ({
  slug,
  repo: `geeera/${slug}`,
  displayName: slug.toUpperCase(),
  routineId: null,
  addedAt: '2026-09-29T00:00:00.000Z',
  archivedAt,
});

describe('appRoutes', () => {
  it('puts the guarded project space before its not-found fallback on the same path', () => {
    const spaceRoutes = appRoutes.filter((route) => route.path === 'p/:slug');

    expect(spaceRoutes).toHaveLength(2);
    expect(spaceRoutes[0]?.canMatch).toEqual([projectExists]);
    expect(spaceRoutes[1]?.canMatch).toBeUndefined();
    expect(spaceRoutes[1]?.data).toEqual({ reason: 'project' });
    expect(appRoutes.at(-1)?.path).toBe('**');
  });
});

describe('App', () => {
  let fixture: ComponentFixture<App>;
  let http: HttpTestingController;
  let router: Router;

  const root = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const text = (selector: string): string => root().querySelector(selector)?.textContent?.trim() ?? '';

  async function boot(
    url: string,
    stored = JSON.stringify(emptyPersistedState()),
    list = [project('a'), project('b')],
  ) {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideRouter(appRoutes, withComponentInputBinding()),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideConsoleI18n(),
        provideAppConfig({ name: 'Team Console', version: '0.0.0', builtAt: 'local' }),
        { provide: PERSISTED_STATE_STORAGE, useValue: memoryPersistedStateStorage(stored) },
      ],
    }).compileComponents();
    await TestBed.inject(ApplicationInitStatus).donePromise;
    http = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
    fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    http.expectOne(NEEDS_YOU_URL).flush([{ project: 'b' }]);

    // The guards await this same load; answering it first keeps every navigation below synchronous enough.
    const ready = TestBed.inject(ProjectsStore).ready();
    http.expectOne(PROJECTS_URL).flush(list);
    await ready;

    await router.navigateByUrl(url);
    await fixture.whenStable();
  }

  afterEach(() => {
    // The question lists (#16) and the sprint board (#18) read on their own; these routing tests do not look at them.
    http
      .match(NEEDS_YOU_URL)
      .forEach((request) => request.flush({ items: [], projects: [], omittedProjects: [] }));
    http
      .match((request) => request.url.endsWith('/questions'))
      .forEach((request) => request.flush({ items: [] }));
    http.match((request) => request.url.endsWith('/sprint')).forEach((request) => request.flush(null));
    // A project space reads its team status for the paused banner (#114); not what these tests look at.
    http
      .match((request) => request.url.endsWith('/team/status'))
      .forEach((request) => request.flush({}, { status: 503, statusText: 'Service Unavailable' }));
    http.verify();
  });

  it('sends the first visit to the cross-project inbox and later visits to the last place', async () => {
    await boot('/');
    expect(router.url).toBe('/needs-you');

    await router.navigateByUrl('/p/b/board');
    await fixture.whenStable();
    expect(TestBed.inject(PersistedStateStore).activeSlug()).toBe('b');

    await router.navigateByUrl('/');
    await fixture.whenStable();
    expect(router.url).toBe('/p/b/board');
  });

  it('opens a project space at its default section with the tabs and the sidebar', async () => {
    await boot('/p/a');

    expect(router.url).toBe('/p/a/questions');
    expect(text('h1')).toBe('A');
    expect(root().querySelector('nav[aria-label="Разделы"]')).not.toBeNull();
    expect(root().querySelectorAll('nav[aria-label="Навигация"] tc-project-switcher')).toHaveLength(1);
  });

  it('shows the shared error block with a way back for an unknown or archived slug, keeping the URL', async () => {
    await boot('/p/nowhere/chat', undefined, [project('a'), project('old', '2026-09-30T00:00:00.000Z')]);
    expect(router.url).toBe('/p/nowhere/chat');
    expect(root().querySelector('[role="alert"]')?.textContent).toContain('Проект не найден');
    expect(root().querySelector('[data-testid="not-found-back"]')?.getAttribute('href')).toBe('/');

    await router.navigateByUrl('/p/old');
    await fixture.whenStable();
    expect(router.url).toBe('/p/old');
    expect(root().querySelector('[role="alert"]')?.textContent).toContain('Проект не найден');
  });

  it('renders the route-not-found variant for any other unknown URL', async () => {
    await boot('/nowhere');

    expect(router.url).toBe('/nowhere');
    expect(root().querySelector('[role="alert"]')?.textContent).toContain('Такой страницы нет');
  });

  it('with no projects, the inbox is the empty state that points to Settings', async () => {
    await boot('/', undefined, []);

    expect(router.url).toBe('/needs-you');
    expect(root().querySelector('[data-testid="no-projects"] a')?.getAttribute('href')).toBe(
      '/settings/projects/new',
    );
  });

  // The chat tab is a placeholder until #17 ships (#203): the deep link lands on the default section instead.
  it('redirects /chat to the project\'s default section with no error screen and no draft text box', async () => {
    await boot('/p/a/chat');

    expect(router.url).toBe('/p/a/questions');
    expect(text('h1')).toBe('A');
    expect(root().querySelector('[data-testid="chat-draft"]')).toBeNull();
    expect(root().querySelector('[role="alert"]')).toBeNull();
  });

  it('a project with a saved last section of `chat` opens the default section on app start (#203)', async () => {
    const stored = JSON.stringify({
      ...emptyPersistedState(),
      activeSlug: 'a',
      projects: { a: { lastPath: 'chat', scroll: {}, chatDraft: '' } },
    });
    await boot('/', stored);

    expect(router.url).toBe('/p/a/questions');
    expect(TestBed.inject(PersistedStateStore).projectState('a')?.lastPath).toBe('questions');
  });
});
