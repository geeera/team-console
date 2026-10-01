import { BreakpointObserver } from '@angular/cdk/layout';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationInitStatus } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { PROJECTS_URL, ProjectsStore } from '@console/entities/project';
import { provideConsoleI18n } from '@console/shared/i18n';
import { Sheet } from '@console/shared/ui';
import { CommandsSheet } from '@console/widgets/commands-panel';
import {
  memoryPersistedStateStorage,
  PERSISTED_STATE_STORAGE,
  PersistedStateStore,
} from '@console/shared/persisted-state';
import { of } from 'rxjs';
import { ProjectSpacePage } from './project-space.page';
import { projectSpaceChildRoutes } from './project-space.routes';

describe('ProjectSpacePage', () => {
  let sheet: { open: ReturnType<typeof vi.fn> };

  async function setup(phone = false) {
    sheet = { open: vi.fn() };
    await TestBed.configureTestingModule({
      providers: [
        provideRouter(
          [{ path: 'p/:slug', component: ProjectSpacePage, children: projectSpaceChildRoutes }],
          withComponentInputBinding(),
        ),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideConsoleI18n(),
        { provide: PERSISTED_STATE_STORAGE, useValue: memoryPersistedStateStorage() },
        { provide: Sheet, useValue: sheet },
        {
          provide: BreakpointObserver,
          useValue: { isMatched: () => phone, observe: () => of({ matches: phone, breakpoints: {} }) },
        },
      ],
    }).compileComponents();
    await TestBed.inject(ApplicationInitStatus).donePromise;
    const http = TestBed.inject(HttpTestingController);
    const ready = TestBed.inject(ProjectsStore).ready();
    http.expectOne(PROJECTS_URL).flush([
      {
        slug: 'tc',
        repo: 'geeera/tc',
        displayName: 'Team Console',
        routineId: null,
        addedAt: '2026-09-29T00:00:00Z',
        archivedAt: null,
      },
    ]);
    await ready;
    const harness = await RouterTestingHarness.create();
    return { harness, http, router: TestBed.inject(Router), state: TestBed.inject(PersistedStateStore) };
  }

  it('shows the project name, the section tabs and redirects the space root to Questions', async () => {
    const { harness, router } = await setup();
    await harness.navigateByUrl('/p/tc');
    const root = harness.routeNativeElement as HTMLElement;

    expect(router.url).toBe('/p/tc/questions');
    expect(root.querySelector('h1')?.textContent?.trim()).toBe('Team Console');
    const tabs = Array.from(root.querySelectorAll('nav[aria-label="Разделы"] a'));
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual([
      'Вопросы',
      'Чат',
      'Доска',
      'Артефакты',
      'Демо',
    ]);
    expect(tabs.map((tab) => tab.getAttribute('aria-current'))).toEqual(['page', null, null, null, null]);
    expect(root.querySelector('nav.tc-tab-bar--bottom')).toBeNull();
  });

  it('moves the current tab with the URL and keeps the chat draft in the store', async () => {
    const { harness, state } = await setup();
    await harness.navigateByUrl('/p/tc/chat');
    const root = harness.routeNativeElement as HTMLElement;

    const tabs = Array.from(root.querySelectorAll('nav a'));
    expect(tabs.map((tab) => tab.getAttribute('aria-current'))).toEqual([null, 'page', null, null, null]);

    const draft = root.querySelector('[data-testid="chat-draft"]') as HTMLTextAreaElement;
    draft.value = 'hi';
    draft.dispatchEvent(new Event('input'));
    expect(state.projectState('tc')?.chatDraft).toBe('hi');
  });

  it('uses the bottom tab bar on the phone', async () => {
    const { harness } = await setup(true);
    await harness.navigateByUrl('/p/tc/board');
    const root = harness.routeNativeElement as HTMLElement;

    expect(root.querySelectorAll('nav')).toHaveLength(1);
    expect(root.querySelector('nav.tc-tab-bar--bottom')).not.toBeNull();
  });

  it('reads the team status for the space and toggles the Commands pane with the button and with K (#114)', async () => {
    const { harness, http } = await setup();
    await harness.navigateByUrl('/p/tc/questions');
    const root = harness.routeNativeElement as HTMLElement;
    expect(http.match('/api/v1/projects/tc/team/status').length).toBeGreaterThan(0);

    const open = root.querySelector('[data-testid="commands-open"]') as HTMLButtonElement;
    expect(open.getAttribute('aria-label')).toBe('Команды проекта Team Console');
    expect(open.getAttribute('aria-expanded')).toBe('false');
    open.click();
    harness.detectChanges();
    expect(root.querySelector('#tc-space-commands tc-commands-panel')).not.toBeNull();
    expect(open.getAttribute('aria-expanded')).toBe('true');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', bubbles: true }));
    harness.detectChanges();
    expect(root.querySelector('#tc-space-commands')).toBeNull();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'л', code: 'KeyK', bubbles: true }));
    harness.detectChanges();
    expect(root.querySelector('#tc-space-commands')).not.toBeNull();
  });

  it('K is ignored while typing or with a modifier', async () => {
    const { harness } = await setup();
    await harness.navigateByUrl('/p/tc/chat');
    const root = harness.routeNativeElement as HTMLElement;
    const draft = root.querySelector('[data-testid="chat-draft"]') as HTMLTextAreaElement;
    draft.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', bubbles: true }));
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', metaKey: true, bubbles: true }),
    );
    harness.detectChanges();
    expect(root.querySelector('#tc-space-commands')).toBeNull();
  });

  it('opens the Commands sheet on the phone', async () => {
    const { harness } = await setup(true);
    await harness.navigateByUrl('/p/tc/board');
    const root = harness.routeNativeElement as HTMLElement;
    (root.querySelector('[data-testid="commands-open"]') as HTMLButtonElement).click();
    expect(sheet.open).toHaveBeenCalledWith(CommandsSheet, {
      title: 'Команды · Team Console',
      data: { slug: 'tc', name: 'Team Console', repo: 'geeera/tc' },
    });
    expect(root.querySelector('#tc-space-commands')).toBeNull();
  });
});
