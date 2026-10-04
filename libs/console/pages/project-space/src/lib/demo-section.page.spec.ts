import { BreakpointObserver } from '@angular/cdk/layout';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationInitStatus } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import {
  ANSWERED_ITEMS_STORAGE,
  embedOriginsUrl,
  PROJECTS_URL,
  ProjectsStore,
} from '@console/entities/project';
import { projectQuestionsUrl } from '@console/entities/question';
import { provideConsoleI18n } from '@console/shared/i18n';
import {
  memoryPersistedStateStorage,
  PERSISTED_STATE_STORAGE,
} from '@console/shared/persisted-state';
import type { QuestionDto, QuestionsDto } from '@shared/contracts';
import { of } from 'rxjs';
import { ProjectSpacePage } from './project-space.page';
import { projectSpaceChildRoutes } from './project-space.routes';

const STORYBOOK = 'https://team-console-storybook.pages.dev';
const STAGE = 'https://team-console-stage.geeera.workers.dev';

function question(number: number, overrides: Partial<QuestionDto>): QuestionDto {
  return {
    section: 'question',
    number,
    title: `Item ${number}`,
    url: `https://github.com/geeera/tc/issues/${number}`,
    ask: null,
    authorTrusted: true,
    body: '',
    allowedCommands: ['approve', 'reject'],
    ...overrides,
  };
}

const QUESTIONS: QuestionsDto = {
  items: [
    question(5, {
      section: 'release',
      title: 'Sprint 01 demo',
      body: `## Scope\n\n- Questions\n\nStage: ${STAGE}/`,
      allowedCommands: ['go', 'no-go', 'override'],
    }),
    question(7, {
      section: 'design',
      title: 'Editor design',
      body: `Prototype: [states](${STORYBOOK}/?path=/story/editor)\n\n<img src=x onerror="window.__pwned=1">`,
    }),
    question(9, { section: 'question', title: 'A plain question' }),
    question(11, { section: 'owner', title: 'An action item', allowedCommands: ['done'] }),
  ],
};

describe('DemoSectionPage (#20)', () => {
  async function setup() {
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
        { provide: ANSWERED_ITEMS_STORAGE, useValue: { read: () => null, write: () => undefined } },
        {
          provide: BreakpointObserver,
          useValue: { isMatched: () => false, observe: () => of({ matches: false, breakpoints: {} }) },
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
    await harness.navigateByUrl('/p/tc/demo');
    const root = harness.routeNativeElement as HTMLElement;
    const settle = async (): Promise<void> => {
      for (let index = 0; index < 5; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      harness.detectChanges();
      await harness.fixture.whenStable();
    };
    return { harness, http, root, settle };
  }

  it('lists only the designs waiting for approval and the demo, as sanitised cards with previews', async () => {
    const { http, root, settle } = await setup();
    http.expectOne(embedOriginsUrl('tc')).flush({ embedOrigins: [STORYBOOK] });
    await settle();
    http.expectOne(projectQuestionsUrl('tc')).flush(QUESTIONS);
    await settle();

    const rows = [...root.querySelectorAll('li[data-number]')].map((row) => row.getAttribute('data-number'));
    expect(rows).toEqual(['5', '7']);
    expect(root.querySelector('ul')?.getAttribute('aria-label')).toBe('Дизайн и демо на ваше решение');

    const frames = [...root.querySelectorAll('iframe')].map((frame) => frame.getAttribute('src'));
    // Stage is link-only: the demo shows a note with Open, the design its Storybook frame.
    expect(frames).toEqual([`${STORYBOOK}/?path=/story/editor`]);
    expect(root.querySelector('li[data-number="5"] [data-testid="frame-open"]')?.getAttribute('href')).toBe(`${STAGE}/`);
    expect(root.querySelector('[data-testid="markdown"] h2')?.textContent).toBe('Scope');
    expect(root.querySelector('img, script')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();

    const demo = root.querySelector('li[data-number="5"]') as HTMLElement;
    expect([...demo.querySelectorAll('[data-command]')].map((button) => button.getAttribute('data-command'))).toEqual(
      ['go', 'no-go', 'override'],
    );
    const design = root.querySelector('li[data-number="7"]') as HTMLElement;
    expect(
      [...design.querySelectorAll('[data-command]')].map((button) => button.getAttribute('data-command')),
    ).toEqual(['approve', 'reject']);
    http.match(() => true);
  });

  it('shows previews as links, with a note, when the embed origins cannot be read', async () => {
    const { http, root, settle } = await setup();
    http.expectOne(embedOriginsUrl('tc')).flush({ message: 'boom' }, { status: 502, statusText: 'Bad Gateway' });
    await settle();
    http.expectOne(projectQuestionsUrl('tc')).flush(QUESTIONS);
    await settle();

    expect(root.querySelector('[data-testid="origins-failed"]')?.textContent).toContain(
      'Не удалось узнать адрес Storybook проекта',
    );
    expect(root.querySelector('iframe')).toBeNull();
    expect(root.querySelectorAll('[data-testid="frame-refused"]')).toHaveLength(2);
    expect(root.querySelectorAll('li[data-number]')).toHaveLength(2);
    http.match(() => true);
  });

  it('says so when nothing waits for a design decision or a go / no-go', async () => {
    const { http, root, settle } = await setup();
    http.expectOne(embedOriginsUrl('tc')).flush({ embedOrigins: [] });
    await settle();
    http.expectOne(projectQuestionsUrl('tc')).flush({ items: [QUESTIONS.items[2]] });
    await settle();

    expect(root.querySelector('[data-testid="empty"]')?.textContent).toContain(
      'Сейчас нет дизайна на согласование и открытого демо',
    );
    http.match(() => true);
  });
});
