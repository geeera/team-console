import { BreakpointObserver } from '@angular/cdk/layout';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationInitStatus, Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { NEEDS_YOU_URL, PROJECTS_URL, ProjectsStore } from '@console/entities/project';
import { provideConsoleI18n } from '@console/shared/i18n';
import {
  emptyPersistedState,
  memoryPersistedStateStorage,
  PERSISTED_STATE_STORAGE,
  PersistedStateStore,
} from '@console/shared/persisted-state';
import { of } from 'rxjs';
import { AppShell } from './app-shell';
import { shellAreaOf } from './shell-location';

// jsdom does no layout: the scroll position is faked on `<main>` below instead of by tall content.
@Component({ template: '<div></div>' })
class Tall {}

describe('shellAreaOf', () => {
  it('tells the spaces, the cross-project screens and the rest apart', () => {
    expect(shellAreaOf('/p/a/chat')).toBe('space');
    expect(shellAreaOf('/needs-you?x=1')).toBe('needs-you');
    expect(shellAreaOf('/overview')).toBe('overview');
    expect(shellAreaOf('/settings/projects/new')).toBe('settings');
    expect(shellAreaOf('/nowhere')).toBe('other');
  });
});

describe('AppShell', () => {
  let fixture: ComponentFixture<AppShell>;
  let http: HttpTestingController;
  let router: Router;
  let state: PersistedStateStore;

  const root = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const main = (): HTMLElement => root().querySelector('main') as HTMLElement;

  async function setup(wide: boolean, stored = JSON.stringify(emptyPersistedState())) {
    await TestBed.configureTestingModule({
      imports: [AppShell],
      providers: [
        provideRouter(
          [
            { path: 'p/:slug/:section', component: Tall },
            { path: '**', component: Tall },
          ],
          withComponentInputBinding(),
        ),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideConsoleI18n(),
        { provide: PERSISTED_STATE_STORAGE, useValue: memoryPersistedStateStorage(stored) },
        {
          provide: BreakpointObserver,
          useValue: { isMatched: () => !wide, observe: () => of({ matches: !wide, breakpoints: {} }) },
        },
      ],
    }).compileComponents();
    await TestBed.inject(ApplicationInitStatus).donePromise;
    http = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
    state = TestBed.inject(PersistedStateStore);

    const ready = TestBed.inject(ProjectsStore).ready();
    http
      .expectOne(PROJECTS_URL)
      .flush([
        {
          slug: 'a',
          repo: 'g/a',
          displayName: 'Alpha',
          routineId: null,
          addedAt: '2026-09-29T00:00:00Z',
          archivedAt: null,
        },
      ]);
    await ready;

    fixture = TestBed.createComponent(AppShell);
    await fixture.whenStable();
    http.expectOne(NEEDS_YOU_URL).flush([{ project: 'a' }, { project: 'a' }]);
    // The counts land a microtask after the flush; give the signal a turn before the next render.
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
  }

  afterEach(() => http.verify());

  it('wide: a sidebar with the navigation, the switcher and Settings; the badge on Needs you', async () => {
    await setup(true);
    const nav = root().querySelector('nav[aria-label="Навигация"]') as HTMLElement;

    expect(nav).not.toBeNull();
    expect(nav.querySelector('tc-project-switcher')).not.toBeNull();
    expect(nav.textContent).toContain('Настройки');
    expect(nav.querySelector('tc-chip .tc-sr-only')?.textContent).toBe('Ждут вас: 2');
    expect(root().querySelector('header')).toBeNull();
  });

  it('phone: a top bar whose title opens the projects sheet', async () => {
    await setup(false);

    expect(root().querySelector('nav[aria-label="Навигация"]')).toBeNull();
    const opener = root().querySelector('header button[aria-haspopup="dialog"]') as HTMLButtonElement;
    expect(opener.textContent).toContain('Консоль команды');

    opener.click();
    await fixture.whenStable();

    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog).not.toBeNull();
    expect(dialog.querySelector('tc-project-switcher')).not.toBeNull();
    expect(dialog.textContent).toContain('Добавить проект');
    dialog.querySelector<HTMLButtonElement>('.tc-sheet__close')?.click();
    await fixture.whenStable();
  });

  it('records the scroll position of a project screen and restores it when the owner returns', async () => {
    await setup(true);
    await router.navigateByUrl('/p/a/questions');
    await fixture.whenStable();
    expect(state.activeSlug()).toBe('a');
    expect(state.projectState('a')?.lastPath).toBe('questions');

    Object.defineProperty(main(), 'scrollTop', { value: 420, writable: true, configurable: true });
    main().dispatchEvent(new Event('scroll'));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    expect(state.scrollOf('a', 'questions')).toBe(420);

    await router.navigateByUrl('/needs-you');
    await fixture.whenStable();
    expect(main().scrollTop).toBe(0);

    await router.navigateByUrl('/p/a/questions');
    await fixture.whenStable();
    expect(main().scrollTop).toBe(420);
  });
});
