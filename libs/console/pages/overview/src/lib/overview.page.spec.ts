import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationInitStatus } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import {
  ANSWERED_ITEMS_STORAGE,
  AnsweredItems,
  OVERVIEW_URL,
  PROJECTS_URL,
  ProjectsStore,
} from '@console/entities/project';
import { provideConsoleI18n, TranslocoService } from '@console/shared/i18n';
import type { OverviewDto, OverviewProjectDto, ProjectDto } from '@shared/contracts';
import { OverviewPage } from './overview.page';

const projectDto = (slug: string): ProjectDto => ({
  slug,
  repo: `geeera/${slug}`,
  displayName: slug,
  routineId: null,
  addedAt: '2026-09-29T00:00:00Z',
  archivedAt: null,
});

const alpha: OverviewProjectDto = {
  kind: 'read',
  slug: 'alpha',
  name: 'Alpha',
  team: 'running',
  sprint: {
    number: 3,
    title: 'Sprint 03 <img src=x onerror=alert(1)>',
    dueOn: '2026-10-16',
    planned: 8,
    shipped: 3,
  },
  needsYou: [7, 9],
  setup: true,
  setupUrl: 'https://github.com/geeera/alpha/blob/HEAD/.product-team/owner-checklist.md',
};

const quietOne: OverviewProjectDto = {
  kind: 'read',
  slug: 'quiet',
  name: 'Quiet',
  team: 'paused',
  sprint: null,
  needsYou: [],
  setup: false,
  setupUrl: null,
};

const broken: OverviewProjectDto = {
  kind: 'failed',
  slug: 'broken',
  name: 'Broken',
  problem: {
    type: 'github-app-not-installed',
    title: 'The console app is not installed on this repository',
    status: 409,
  },
};

const pending: OverviewProjectDto = {
  kind: 'failed',
  slug: 'later',
  name: 'Later',
  problem: { type: 'github-request-budget', title: 'Not read in this request', status: 503 },
};

describe('OverviewPage', () => {
  let http: HttpTestingController;

  async function render(list: ProjectDto[]) {
    await TestBed.configureTestingModule({
      imports: [OverviewPage],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideConsoleI18n(),
        { provide: ANSWERED_ITEMS_STORAGE, useValue: { read: () => null, write: () => undefined } },
      ],
    }).compileComponents();
    await TestBed.inject(ApplicationInitStatus).donePromise;
    http = TestBed.inject(HttpTestingController);
    const ready = TestBed.inject(ProjectsStore).ready();
    http.expectOne(PROJECTS_URL).flush(list);
    await ready;
    const fixture = TestBed.createComponent(OverviewPage);
    await fixture.whenStable();
    return { root: fixture.nativeElement as HTMLElement, fixture };
  }

  /** The page awaits the response as a promise: let it resolve, then render. */
  async function settle(fixture: { whenStable: () => Promise<unknown> }): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await fixture.whenStable();
  }

  async function answer(fixture: { whenStable: () => Promise<unknown> }, body: OverviewDto): Promise<void> {
    const request = http.expectOne(OVERVIEW_URL);
    expect(request.request.method).toBe('GET');
    request.flush(body);
    await settle(fixture);
  }

  const tile = (root: HTMLElement, slug: string): HTMLElement =>
    root.querySelector(`[data-project="${slug}"]`) as HTMLElement;

  it('with no projects it is the empty state that points to Settings, and reads nothing', async () => {
    const { root } = await render([]);
    expect(root.querySelector('h1')?.textContent?.trim()).toBe('Все проекты');
    expect(root.querySelector('[data-testid="no-projects"] a')?.getAttribute('href')).toBe(
      '/settings/projects/new',
    );
    http.expectNone(OVERVIEW_URL);
  });

  it('shows one tile per project, linking to its board; the quiet ones below', async () => {
    const { root, fixture } = await render([projectDto('alpha'), projectDto('quiet'), projectDto('broken')]);
    expect(root.querySelector('[data-testid="loading"]')).not.toBeNull();
    await answer(fixture, { projects: [alpha, quietOne, broken], checkedAt: '2026-10-01T12:00:00Z' });

    expect(root.querySelector('[data-testid="count"]')?.textContent?.trim()).toBe('3 проекта');
    const main = root.querySelector('[data-testid="overview-list"]') as HTMLElement;
    const quiet = root.querySelector('[data-testid="overview-quiet"]') as HTMLElement;
    expect([...main.querySelectorAll('[data-project]')].map((el) => el.getAttribute('data-project'))).toEqual(
      ['alpha', 'broken'],
    );
    expect(
      [...quiet.querySelectorAll('[data-project]')].map((el) => el.getAttribute('data-project')),
    ).toEqual(['quiet']);

    const a = tile(root, 'alpha');
    expect(a.tagName).toBe('A');
    expect(a.getAttribute('href')).toBe('/p/alpha/board');
    expect(a.querySelector('[data-testid="team"]')?.textContent?.trim()).toBe('В работе');
    // The milestone title is untrusted: text, never markup.
    expect(a.querySelector('[data-testid="sprint"]')?.textContent).toContain(
      'Sprint 03 <img src=x onerror=alert(1)>',
    );
    expect(a.querySelector('img')).toBeNull();
    expect(a.querySelector('[data-testid="sprint"]')?.textContent).toContain('демо 16 октября');
    expect(a.querySelector('[data-testid="progress"]')?.textContent?.trim()).toBe('готово 3 из 8');
    expect(a.querySelector('tc-meter')?.getAttribute('aria-hidden')).toBe('true');
    expect(a.querySelector('[data-testid="setup"]')?.textContent?.trim()).toBe('Нужна настройка');
    expect(a.querySelector('[data-testid="needs-you"] .tc-sr-only')?.textContent?.trim()).toBe('Ждут вас: 2');

    const q = tile(root, 'quiet');
    expect(q.querySelector('[data-testid="team"]')?.textContent?.trim()).toBe('На паузе');
    expect(q.querySelector('[data-testid="sprint"]')?.textContent?.trim()).toBe('Нет текущего спринта');
    expect(q.querySelector('[data-testid="needs-you"]')).toBeNull();

    const b = tile(root, 'broken');
    expect(b.getAttribute('href')).toBe('/p/broken/board');
    expect(b.querySelector('[data-testid="problem"]')?.textContent?.trim()).toBe(
      'Не удалось прочитать: приложение консоли не установлено в репозитории',
    );
    expect(root.querySelector('[data-testid="partial"]')).toBeNull();

    TestBed.inject(TranslocoService).setActiveLang('en');
    await fixture.whenStable();
    expect(a.querySelector('[data-testid="progress"]')?.textContent?.trim()).toBe('3 of 8 done');
    expect(a.querySelector('[data-testid="sprint"]')?.textContent).toContain('demo 16 October');
    expect(root.querySelector('[data-testid="count"]')?.textContent?.trim()).toBe('3 projects');
  });

  it('leaves out an item answered from this device while GitHub still lists it', async () => {
    const { root, fixture } = await render([projectDto('alpha')]);
    await answer(fixture, { projects: [alpha], checkedAt: '2026-10-01T12:00:00Z' });
    TestBed.inject(AnsweredItems).record({
      slug: 'alpha',
      number: 7,
      command: 'approve',
      url: 'https://github.com/geeera/alpha/issues/7#issuecomment-1',
      answeredAt: new Date().toISOString(),
    });
    await fixture.whenStable();
    expect(
      tile(root, 'alpha').querySelector('[data-testid="needs-you"] .tc-sr-only')?.textContent?.trim(),
    ).toBe('Ждут вас: 1');
  });

  it('says which projects did not fit into the request and loads the rest on demand', async () => {
    const { root, fixture } = await render([projectDto('alpha'), projectDto('later')]);
    await answer(fixture, { projects: [alpha, pending], checkedAt: '2026-10-01T12:00:00Z' });

    expect(tile(root, 'later').querySelector('[data-testid="problem"]')?.textContent?.trim()).toBe(
      'Ещё не загружен: не уместился в один запрос',
    );
    const loadRest = root.querySelector('[data-testid="load-rest"]') as HTMLButtonElement;
    loadRest.click();
    await fixture.whenStable();
    // The tiles stay while the rest loads.
    expect(tile(root, 'alpha')).not.toBeNull();
    await answer(fixture, {
      projects: [alpha, { ...quietOne, slug: 'later', name: 'Later' }],
      checkedAt: '2026-10-01T12:00:05Z',
    });
    expect(root.querySelector('[data-testid="partial"]')).toBeNull();
    expect(tile(root, 'later').querySelector('[data-testid="team"]')).not.toBeNull();
  });

  it.each([
    [429, 'rate-limited', 'GitHub просит подождать'],
    [0, 'offline', 'Нет соединения'],
    [502, 'unavailable', 'Не удалось загрузить сводку'],
  ] as const)('a %s answer is a %s error with Retry', async (status, failure, title) => {
    const { root, fixture } = await render([projectDto('alpha')]);
    const request = http.expectOne(OVERVIEW_URL);
    if (status === 0) {
      request.error(new ProgressEvent('error'), { status: 0 });
    } else {
      request.flush({ type: 'about:blank', title: 'x', status }, { status, statusText: 'x' });
    }
    await settle(fixture);
    const block = root.querySelector('[data-testid="load-error"]') as HTMLElement;
    expect(block.getAttribute('data-failure')).toBe(failure);
    expect(block.textContent).toContain(title);

    (block.querySelector('button') as HTMLButtonElement).click();
    await fixture.whenStable();
    await answer(fixture, { projects: [alpha], checkedAt: '2026-10-01T12:00:00Z' });
    expect(tile(root, 'alpha')).not.toBeNull();
  });

  it('shows a response of an unexpected shape as the generic failure', async () => {
    const { root, fixture } = await render([projectDto('alpha')]);
    await answer(fixture, { projects: [{ kind: 'read', slug: 'alpha' }] } as unknown as OverviewDto);
    expect(root.querySelector('[data-testid="load-error"]')?.getAttribute('data-failure')).toBe(
      'unavailable',
    );
  });
});
