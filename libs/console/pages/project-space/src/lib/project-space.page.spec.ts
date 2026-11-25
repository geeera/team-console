import { BreakpointObserver } from '@angular/cdk/layout';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationInitStatus, ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { PROJECTS_URL, ProjectsStore } from '@console/entities/project';
import { projectSprintUrl } from '@console/entities/sprint';
import { provideConsoleI18n } from '@console/shared/i18n';
import { Sheet, TopBarActions } from '@console/shared/ui';
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

  it('shows the project name, the section tabs (chat hidden, #203) and redirects the space root to Questions', async () => {
    const { harness, router } = await setup();
    await harness.navigateByUrl('/p/tc');
    const root = harness.routeNativeElement as HTMLElement;

    expect(router.url).toBe('/p/tc/questions');
    expect(root.querySelector('h1')?.textContent?.trim()).toBe('Team Console');
    const tabs = Array.from(root.querySelectorAll('nav[aria-label="Разделы"] a'));
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual(['Вопросы', 'Доска', 'Артефакты', 'Демо']);
    expect(tabs.map((tab) => tab.getAttribute('aria-current'))).toEqual(['page', null, null, null]);
    expect(root.querySelector('nav.tc-tab-bar--bottom')).toBeNull();
  });

  it('a `/chat` deep link redirects to Questions instead of showing the placeholder (#203)', async () => {
    const { harness, router } = await setup();
    await harness.navigateByUrl('/p/tc/chat');
    const root = harness.routeNativeElement as HTMLElement;

    expect(router.url).toBe('/p/tc/questions');
    expect(root.querySelector('[data-testid="chat-draft"]')).toBeNull();
    const tabs = Array.from(root.querySelectorAll('nav a'));
    expect(tabs.map((tab) => tab.getAttribute('aria-current'))).toEqual(['page', null, null, null]);
  });

  it('moves the current tab with the URL', async () => {
    const { harness } = await setup();
    await harness.navigateByUrl('/p/tc/board');
    const root = harness.routeNativeElement as HTMLElement;

    const tabs = Array.from(root.querySelectorAll('nav a'));
    expect(tabs.map((tab) => tab.getAttribute('aria-current'))).toEqual([null, 'page', null, null]);
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
    await harness.navigateByUrl('/p/tc/questions');
    const root = harness.routeNativeElement as HTMLElement;
    const input = document.createElement('input');
    root.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', bubbles: true }));
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', metaKey: true, bubbles: true }),
    );
    harness.detectChanges();
    expect(root.querySelector('#tc-space-commands')).toBeNull();
  });

  it('offers Commands to the shell top bar on the phone and opens the sheet from there', async () => {
    const { harness } = await setup(true);
    await harness.navigateByUrl('/p/tc/board');
    const root = harness.routeNativeElement as HTMLElement;
    expect(root.querySelector('[data-testid="commands-open"]')).toBeNull();
    // What the shell does with it: render the offered template in its top bar.
    const template = TestBed.inject(TopBarActions).template();
    if (template === null) {
      throw new Error('the space offered no top-bar action');
    }
    const view = template.createEmbeddedView({});
    TestBed.inject(ApplicationRef).attachView(view);
    view.detectChanges();
    const button = view.rootNodes.find(
      (node: Node) => node instanceof HTMLButtonElement,
    ) as HTMLButtonElement;
    expect(button.getAttribute('aria-label')).toBe('Команды проекта Team Console');
    button.click();
    expect(sheet.open).toHaveBeenCalledWith(CommandsSheet, {
      title: 'Команды · Team Console',
      data: { slug: 'tc', name: 'Team Console', repo: 'geeera/tc' },
    });
    expect(root.querySelector('#tc-space-commands')).toBeNull();
  });

  it("renders the sprint board in the Board section, read from the project's sprint read model", async () => {
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
