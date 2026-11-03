import { BreakpointObserver } from '@angular/cdk/layout';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationInitStatus, Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { HEALTH_URL } from '@console/entities/app-info';
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

// jsdom does no layout: the document's scroll position is faked below instead of by tall content.
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

  afterEach(() => {
    // The environment mark asks where the app runs (#237); tests that do not look at it leave it unknown.
    http.match(HEALTH_URL).forEach((request) => request.flush(null, { status: 502, statusText: 'Bad Gateway' }));
    http.verify();
  });

  it.each([
    [true, 'nav'],
    [false, 'header'],
  ] as const)('marks a non-production environment in text in the %s layout (#237)', async (wide, landmark) => {
    await setup(wide);
    http.expectOne(HEALTH_URL).flush({ status: 'ok', environment: 'stage', version: '0.1.0' });
    // The environment lands a microtask after the flush.
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();

    const mark = root().querySelector(`${landmark} [data-testid="environment-mark"]`);
    expect(mark?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Окружение: Stage');
  });

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
    // The sheet is its own chunk, imported on the first tap (#123).
    const dialog = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>('[role="dialog"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    await fixture.whenStable();
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

    // Only the document scrolls (#274): the position is the document's, recorded on the window's scroll.
    const page = document.scrollingElement ?? document.documentElement;
    Object.defineProperty(page, 'scrollTop', { value: 420, writable: true, configurable: true });
    try {
      window.dispatchEvent(new Event('scroll'));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      expect(state.scrollOf('a', 'questions')).toBe(420);

      await router.navigateByUrl('/needs-you');
      await fixture.whenStable();
      expect(page.scrollTop).toBe(0);

      await router.navigateByUrl('/p/a/questions');
      await fixture.whenStable();
      expect(page.scrollTop).toBe(420);
    } finally {
      delete (page as { scrollTop?: number }).scrollTop;
    }
  });

  it('does not record the position a sheet pins the page at', async () => {
    await setup(true);
    await router.navigateByUrl('/p/a/questions');
    await fixture.whenStable();
    const page = document.scrollingElement ?? document.documentElement;
    const frame = (): Promise<unknown> => new Promise((resolve) => requestAnimationFrame(resolve));
    Object.defineProperty(page, 'scrollTop', { value: 420, writable: true, configurable: true });
    try {
      window.dispatchEvent(new Event('scroll'));
      await frame();
      expect(state.scrollOf('a', 'questions')).toBe(420);

      // A sheet opens: the CDK pins <html> and its scroll position reads 0 until the sheet closes.
      page.setAttribute('data-tc-scroll-lock', '');
      page.scrollTop = 0;
      window.dispatchEvent(new Event('scroll'));
      await frame();
      expect(state.scrollOf('a', 'questions')).toBe(420);
    } finally {
      page.removeAttribute('data-tc-scroll-lock');
      delete (page as { scrollTop?: number }).scrollTop;
    }
  });
});
