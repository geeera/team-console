import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationInitStatus } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ANSWERED_ITEMS_STORAGE, PROJECTS_URL, ProjectsStore } from '@console/entities/project';
import { NEEDS_YOU_ITEMS_URL } from '@console/entities/question';
import { provideConsoleI18n } from '@console/shared/i18n';
import { NeedsYouDto, ProjectDto } from '@shared/contracts';
import { NeedsYouPage } from './needs-you.page';

describe('NeedsYouPage', () => {
  async function render(list: ProjectDto[]) {
    await TestBed.configureTestingModule({
      imports: [NeedsYouPage],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideConsoleI18n(),
        { provide: ANSWERED_ITEMS_STORAGE, useValue: { read: () => null, write: () => undefined } },
      ],
    }).compileComponents();
    await TestBed.inject(ApplicationInitStatus).donePromise;
    const ready = TestBed.inject(ProjectsStore).ready();
    TestBed.inject(HttpTestingController).expectOne(PROJECTS_URL).flush(list);
    await ready;
    const fixture = TestBed.createComponent(NeedsYouPage);
    await fixture.whenStable();
    return { root: fixture.nativeElement as HTMLElement, fixture };
  }

  it('with no projects it is the empty state that points to All projects (#194)', async () => {
    const { root } = await render([]);

    expect(root.querySelector('h1')?.textContent?.trim()).toBe('Ждут вас');
    const block = root.querySelector('[data-testid="no-projects"]') as HTMLElement;
    expect(block.textContent).toContain('Проектов пока нет');
    expect(block.querySelector('a')?.getAttribute('href')).toBe('/overview#add-project');
  });

  it('with projects it lists every waiting item, tagged with its project', async () => {
    const { root, fixture } = await render([
      {
        slug: 'a',
        repo: 'g/a',
        displayName: 'A',
        routineId: null,
        addedAt: '2026-09-29T00:00:00Z',
        archivedAt: null,
      },
    ]);

    const body: NeedsYouDto = {
      items: [
        {
          section: 'question',
          number: 72,
          title: 'План к демо 16 октября',
          url: 'https://github.com/g/a/issues/72',
          ask: '/approve — начинаем',
          authorTrusted: true,
          category: 'scope',
          recommendation: null,
          project: { slug: 'a', name: 'A' },
          allowedCommands: ['approve', 'reject'],
        },
      ],
      projects: [
        { slug: 'a', name: 'A', setup: false, setupUrl: null, paused: false, pausedUrl: null, problem: null },
      ],
      omittedProjects: [],
    };
    TestBed.inject(HttpTestingController).expectOne(NEEDS_YOU_ITEMS_URL).flush(body);
    await fixture.whenStable();

    await new Promise((resolve) => setTimeout(resolve, 0));
    await fixture.whenStable();
    expect(root.querySelector('[data-testid="no-projects"]')).toBeNull();
    expect(root.querySelector('tc-question-card h2')?.textContent).toBe('План к демо 16 октября');
    expect(root.querySelector('[data-testid="project-tag"]')?.textContent?.trim()).toBe('A');
  });
});
