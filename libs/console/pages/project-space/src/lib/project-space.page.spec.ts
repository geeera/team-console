import { BreakpointObserver } from '@angular/cdk/layout';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationInitStatus } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { PROJECTS_URL, ProjectsStore } from '@console/entities/project';
import { projectSprintUrl } from '@console/entities/sprint';
import { provideConsoleI18n } from '@console/shared/i18n';
import {
  memoryPersistedStateStorage,
  PERSISTED_STATE_STORAGE,
  PersistedStateStore,
} from '@console/shared/persisted-state';
import { of } from 'rxjs';
import { ProjectSpacePage } from './project-space.page';
import { projectSpaceChildRoutes } from './project-space.routes';

describe('ProjectSpacePage', () => {
  async function setup(phone = false) {
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
        {
          provide: BreakpointObserver,
          useValue: { isMatched: () => phone, observe: () => of({ matches: phone, breakpoints: {} }) },
        },
      ],
    }).compileComponents();
    await TestBed.inject(ApplicationInitStatus).donePromise;
    const http = TestBed.inject(HttpTestingController);
    const ready = TestBed.inject(ProjectsStore).ready();
    http
      .expectOne(PROJECTS_URL)
      .flush([
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

  it('renders the sprint board in the Board section, read from the project\'s sprint read model', async () => {
    const { harness, http } = await setup();
    await harness.navigateByUrl('/p/tc/board');
    const root = harness.routeNativeElement as HTMLElement;

    expect(root.querySelector('tc-sprint-board')).not.toBeNull();
    const request = http.expectOne(projectSprintUrl('tc'));
    expect(request.request.method).toBe('GET');
    request.flush({
      milestone: null,
      issues: [],
      byStatus: {},
      planned: 0,
      shipped: 0,
      carriedOver: 0,
      byTier: {},
      openPullRequests: [],
    });
  });
});
