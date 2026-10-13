import { BreakpointObserver } from '@angular/cdk/layout';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationInitStatus } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { projectArtifactsUrl } from '@console/entities/artifact';
import { PROJECTS_URL, ProjectsStore } from '@console/entities/project';
import { provideConsoleI18n, TranslocoService } from '@console/shared/i18n';
import { memoryPersistedStateStorage, PERSISTED_STATE_STORAGE } from '@console/shared/persisted-state';
import type { ArtifactDto, ArtifactsResponse } from '@shared/contracts';
import { of } from 'rxjs';
import { ProjectSpacePage } from './project-space.page';
import { projectSpaceChildRoutes } from './project-space.routes';

const DECISION: ArtifactDto = {
  type: 'decision',
  title: 'Stack and architecture',
  url: 'https://github.com/geeera/tc/blob/main/docs/decisions/0001-stack.md',
  updatedAt: null,
  source: 'file',
  state: null,
};

const DESIGN: ArtifactDto = {
  type: 'design',
  title: 'Design viewer',
  url: 'https://github.com/geeera/tc/issues/277',
  updatedAt: '2026-10-01T10:00:00Z',
  source: 'issue',
  state: 'open',
  number: 277,
};

function response(items: readonly ArtifactDto[]): ArtifactsResponse {
  return { items, loadedAt: '2026-10-09T09:00:00Z' };
}

const textOf = (element: Element | null | undefined): string =>
  element?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

describe('ArtifactsSectionPage, the Design filter states (#295, #277 spec §4)', () => {
  async function setup(url: string) {
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
    await harness.navigateByUrl(url);
    const root = harness.routeNativeElement as HTMLElement;
    const settle = async (): Promise<void> => {
      for (let index = 0; index < 5; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      harness.detectChanges();
      await harness.fixture.whenStable();
    };
    await settle();
    const query = (selector: string): HTMLElement | null => root.querySelector(selector);
    const answer = async (items: readonly ArtifactDto[]): Promise<void> => {
      http.expectOne(projectArtifactsUrl('tc')).flush(response(items));
      await settle();
    };
    return { harness, http, root, settle, query, answer };
  }

  afterEach(() => {
    // The space's other reads (needs-you counts, team status) are not this page's business.
    TestBed.inject(HttpTestingController).match(() => true);
  });

  it('loads the Design filter as three skeleton rows and a «Загружаем дизайны…» status, not the generic block', async () => {
    const { query, root } = await setup('/p/tc/artifacts?type=design');
    const loading = query('[data-testid="artifacts-designs-loading"]');
    expect(loading).not.toBeNull();
    expect(loading?.getAttribute('aria-busy')).toBe('true');
    expect(root.querySelectorAll('.artifacts__skeleton[aria-hidden="true"]')).toHaveLength(3);
    const status = loading?.querySelector('[role="status"]');
    expect(textOf(status)).toBe('Загружаем дизайны…');
    expect(query('[data-testid="artifacts-loading"]')).toBeNull();
  });

  it('keeps the generic loading block for the other filters', async () => {
    const { query } = await setup('/p/tc/artifacts');
    expect(textOf(query('[data-testid="artifacts-loading"]'))).toBe('Загружаю артефакты…');
    expect(query('[data-testid="artifacts-designs-loading"]')).toBeNull();
  });

  it('says «Дизайнов пока нет» when the project has artifacts but no design, with the type toggles still there', async () => {
    const { query, answer } = await setup('/p/tc/artifacts?type=design');
    await answer([DECISION]);
    const empty = query('[data-testid="artifacts-designs-empty"]');
    expect(textOf(empty?.querySelector('.tc-state-block__title'))).toBe('Дизайнов пока нет');
    expect(textOf(empty?.querySelector('.tc-state-block__description'))).toBe(
      'Когда дизайнер приложит экраны к задаче, они появятся здесь.',
    );
    expect(query('tc-artifact-search')).not.toBeNull();
    expect(query('[data-testid="artifacts-no-match"]')).toBeNull();
    expect(query('[data-testid="artifacts-empty"]')).toBeNull();
  });

  it('says the same when the project has no artifacts at all and the Design filter is on', async () => {
    const { query, answer } = await setup('/p/tc/artifacts?type=design');
    await answer([]);
    expect(textOf(query('[data-testid="artifacts-designs-empty"] .tc-state-block__title'))).toBe(
      'Дизайнов пока нет',
    );
    expect(query('[data-testid="artifacts-empty"]')).toBeNull();
  });

  it('keeps the generic empty state and «Ничего не найдено» for the other cases', async () => {
    const { query, answer } = await setup('/p/tc/artifacts?type=design&q=nothing+like+this');
    await answer([DESIGN, DECISION]);
    // A search over the Design filter that finds nothing: the clear action must stay.
    expect(textOf(query('[data-testid="artifacts-no-match"] .tc-state-block__title'))).toBe('Ничего не найдено');
    expect(query('[data-testid="artifacts-no-match"] button')).not.toBeNull();
    expect(query('[data-testid="artifacts-designs-empty"]')).toBeNull();
  });

  it('shows the generic empty state without a filter when there is nothing at all', async () => {
    const { query, answer } = await setup('/p/tc/artifacts');
    await answer([]);
    expect(textOf(query('[data-testid="artifacts-empty"] .tc-state-block__title'))).toBe('Артефактов пока нет');
    expect(query('[data-testid="artifacts-designs-empty"]')).toBeNull();
  });

  it('lists the design rows when the filter has something to show', async () => {
    const { query, root, answer, http } = await setup('/p/tc/artifacts?type=design');
    await answer([DESIGN, DECISION]);
    expect(root.querySelectorAll('[data-testid="artifact"]')).toHaveLength(1);
    expect(query('[data-testid="artifacts-designs-empty"]')).toBeNull();
    http.match(/\/designs\/277$/);
  });

  it('has the English copy too', async () => {
    const { query, answer, settle } = await setup('/p/tc/artifacts?type=design');
    TestBed.inject(TranslocoService).setActiveLang('en');
    await settle();
    expect(textOf(query('[data-testid="artifacts-designs-loading"] [role="status"]'))).toBe('Loading designs…');
    await answer([DECISION]);
    const empty = query('[data-testid="artifacts-designs-empty"]');
    expect(textOf(empty?.querySelector('.tc-state-block__title'))).toBe('No designs yet');
    expect(textOf(empty?.querySelector('.tc-state-block__description'))).toBe(
      'Once the designer attaches screens to an issue, they show up here.',
    );
  });
});
