import { BreakpointObserver } from '@angular/cdk/layout';
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
import { Sheet } from '@console/shared/ui';
import { CommandsSheet } from '@console/widgets/commands-panel';
import type { OverviewDto, OverviewProjectDto, ProjectDto } from '@shared/contracts';
import { of } from 'rxjs';
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
  snooze: { snoozed: false },
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
  snooze: { snoozed: false },
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
  let sheet: { open: ReturnType<typeof vi.fn> };

  async function render(list: ProjectDto[], { phone = false }: { phone?: boolean } = {}) {
    sheet = { open: vi.fn() };
    await TestBed.configureTestingModule({
      imports: [OverviewPage],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideConsoleI18n(),
        { provide: ANSWERED_ITEMS_STORAGE, useValue: { read: () => null, write: () => undefined } },
        { provide: Sheet, useValue: sheet },
        {
          provide: BreakpointObserver,
          useValue: { isMatched: () => phone, observe: () => of({ matches: phone, breakpoints: {} }) },
        },
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

  it('with no projects it is a short note above the GitHub list, and reads no overview', async () => {
    const { root } = await render([]);
    expect(root.querySelector('h1')?.textContent?.trim()).toBe('Все проекты');
    const note = root.querySelector('[data-testid="no-projects"]') as HTMLElement;
    expect(note.textContent).toContain('Проектов пока нет');
    expect(note.textContent).toContain('Доступны на GitHub');
    expect(root.querySelector('tc-github-repositories-block')).not.toBeNull();
    http.expectNone(OVERVIEW_URL);
  });

  it('shows "Available on GitHub" under the projects (#194)', async () => {
    const { root } = await render([projectDto('alpha')]);
    expect(root.querySelector('[data-testid="github-repositories"] h2')?.textContent?.trim()).toBe(
      'Доступны на GitHub',
    );
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

  it('reads the overview again when a project is added, keeping the tiles meanwhile (#242)', async () => {
    const { root, fixture } = await render([projectDto('alpha')]);
    await answer(fixture, { projects: [alpha], checkedAt: '2026-10-01T12:00:00Z' });
    expect(root.querySelector('[data-testid="count"]')?.textContent?.trim()).toBe('1 проект');

    TestBed.inject(ProjectsStore).upsert(projectDto('quiet'));
    await settle(fixture);
    expect(tile(root, 'alpha')).not.toBeNull();
    await answer(fixture, { projects: [alpha, quietOne], checkedAt: '2026-10-01T12:01:00Z' });

    expect(root.querySelector('[data-testid="count"]')?.textContent?.trim()).toBe('2 проекта');
    expect(tile(root, 'quiet')).not.toBeNull();
  });

  it('does not read the overview again when the project list is re-read unchanged', async () => {
    const { fixture } = await render([projectDto('alpha')]);
    await answer(fixture, { projects: [alpha], checkedAt: '2026-10-01T12:00:00Z' });
    TestBed.inject(ProjectsStore).upsert(projectDto('alpha'));
    await settle(fixture);
    http.expectNone(OVERVIEW_URL);
  });

  it('shows a response of an unexpected shape as the generic failure', async () => {
    const { root, fixture } = await render([projectDto('alpha')]);
    await answer(fixture, { projects: [{ kind: 'read', slug: 'alpha' }] } as unknown as OverviewDto);
    expect(root.querySelector('[data-testid="load-error"]')?.getAttribute('data-failure')).toBe(
      'unavailable',
    );
  });

  describe('Commands on every card (#222)', () => {
    const commandsFor = (root: HTMLElement, slug: string): HTMLButtonElement =>
      root.querySelector(`[data-commands-for="${slug}"]`) as HTMLButtonElement;
    const pane = (root: HTMLElement): HTMLElement | null => root.querySelector('#tc-overview-commands');
    const key = (target: EventTarget, init: KeyboardEventInit): void => {
      target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    };

    async function ready(options: { phone?: boolean } = {}) {
      const rendered = await render([projectDto('alpha'), projectDto('quiet'), projectDto('broken')], options);
      await answer(rendered.fixture, { projects: [alpha, quietOne, broken], checkedAt: '2026-10-01T12:00:00Z' });
      return rendered;
    }

    it('gives every card, read or not, a Commands button named for its project, beside the link', async () => {
      const { root } = await ready();
      for (const [slug, name] of [
        ['alpha', 'Alpha'],
        ['quiet', 'Quiet'],
        ['broken', 'Broken'],
      ]) {
        const button = commandsFor(root, slug);
        expect(button.getAttribute('aria-label')).toBe(`Команды проекта ${name}`);
        expect(button.getAttribute('aria-keyshortcuts')).toBe('K');
        expect(button.getAttribute('aria-expanded')).toBe('false');
        expect(button.textContent).toContain('Команды');
        // Never inside the link: a link holds no button.
        expect(button.closest('a')).toBeNull();
        expect(button.closest(`[data-card-slug="${slug}"]`)).not.toBeNull();
      }
    });

    it('opens the pane for that card, moves it to another card, and returns focus to the button on close', async () => {
      const { root, fixture } = await ready();
      commandsFor(root, 'alpha').click();
      await fixture.whenStable();
      expect(http.match('/api/v1/projects/alpha/team/status').length).toBe(1);
      expect(pane(root)?.getAttribute('aria-label')).toBe('Команды · Alpha');
      expect(pane(root)?.querySelector('tc-commands-panel')).not.toBeNull();
      expect(commandsFor(root, 'alpha').getAttribute('aria-expanded')).toBe('true');
      expect(commandsFor(root, 'alpha').getAttribute('aria-controls')).toBe('tc-overview-commands');
      expect(document.activeElement?.classList.contains('cp__title')).toBe(true);

      commandsFor(root, 'quiet').click();
      await fixture.whenStable();
      expect(http.match('/api/v1/projects/quiet/team/status').length).toBe(1);
      expect(pane(root)?.getAttribute('aria-label')).toBe('Команды · Quiet');
      expect(commandsFor(root, 'alpha').getAttribute('aria-expanded')).toBe('false');

      (pane(root)?.querySelector('.cp__close') as HTMLButtonElement).click();
      await fixture.whenStable();
      expect(pane(root)).toBeNull();
      expect(document.activeElement).toBe(commandsFor(root, 'quiet'));
    });

    it('K on a focused card opens its pane; K again from the pane, or Escape, closes it back to the button', async () => {
      const { root, fixture } = await ready();
      const link = tile(root, 'quiet');
      link.focus();
      key(link, { key: 'k', code: 'KeyK' });
      await fixture.whenStable();
      expect(pane(root)?.getAttribute('aria-label')).toBe('Команды · Quiet');

      const title = pane(root)?.querySelector('.cp__title') as HTMLElement;
      key(title, { key: 'л', code: 'KeyK' });
      await fixture.whenStable();
      expect(pane(root)).toBeNull();
      expect(document.activeElement).toBe(commandsFor(root, 'quiet'));

      key(commandsFor(root, 'quiet'), { key: 'K', code: 'KeyK' });
      await fixture.whenStable();
      expect(pane(root)).not.toBeNull();
      key(pane(root)?.querySelector('.cp__title') as HTMLElement, { key: 'Escape', code: 'Escape' });
      await fixture.whenStable();
      expect(pane(root)).toBeNull();
      expect(document.activeElement).toBe(commandsFor(root, 'quiet'));
    });

    it('leaves K alone off the cards, while typing and with a modifier', async () => {
      const { root, fixture } = await ready();
      key(root.querySelector('h1') as HTMLElement, { key: 'k', code: 'KeyK' });
      const input = document.createElement('input');
      tile(root, 'alpha').appendChild(input);
      key(input, { key: 'k', code: 'KeyK' });
      key(tile(root, 'alpha'), { key: 'k', code: 'KeyK', metaKey: true });
      await fixture.whenStable();
      expect(pane(root)).toBeNull();
      input.remove();
    });

    it('opens the same panel in a sheet on the phone, with no K and no pane', async () => {
      const { root, fixture } = await ready({ phone: true });
      const button = commandsFor(root, 'alpha');
      expect(button.getAttribute('aria-haspopup')).toBe('dialog');
      expect(button.getAttribute('aria-keyshortcuts')).toBeNull();
      expect(button.querySelector('kbd')).toBeNull();
      button.click();
      expect(http.match('/api/v1/projects/alpha/team/status').length).toBe(1);
      expect(sheet.open).toHaveBeenCalledWith(CommandsSheet, {
        title: 'Команды · Alpha',
        data: { slug: 'alpha', name: 'Alpha', repo: 'geeera/alpha' },
      });
      key(tile(root, 'alpha'), { key: 'k', code: 'KeyK' });
      await fixture.whenStable();
      expect(pane(root)).toBeNull();
      expect(sheet.open).toHaveBeenCalledTimes(1);
    });
  });

  describe('the snoozed line (#222)', () => {
    it('shows the struck bell and the words on a snoozed card, and nothing on the others', async () => {
      const { root, fixture } = await render([projectDto('alpha'), projectDto('quiet')]);
      const snooze = { snoozed: true, until: null, allowsUrgent: true, since: '2026-10-01T09:00:00Z' } as const;
      await answer(fixture, { projects: [alpha, { ...quietOne, snooze }], checkedAt: '2026-10-01T12:00:00Z' });
      const line = tile(root, 'quiet').querySelector('[data-testid="snoozed"]') as HTMLElement;
      expect(line.textContent?.trim()).toBe('уведомления отложены');
      expect(line.querySelector('tc-icon')?.getAttribute('name')).toBe('bell-off');
      expect(tile(root, 'alpha').querySelector('[data-testid="snoozed"]')).toBeNull();
      // The sidebar reads the registry list: the overview's fresher read reaches it.
      expect(TestBed.inject(ProjectsStore).bySlug('quiet')?.snooze).toEqual(snooze);
    });

    it('says until when, and drops an expired snooze', async () => {
      const { root, fixture } = await render([projectDto('alpha'), projectDto('quiet')]);
      const until = new Date(Date.now() + 3_600_000).toISOString();
      await answer(fixture, {
        projects: [
          { ...alpha, snooze: { snoozed: true, until, allowsUrgent: false, since: '2026-10-01T09:00:00Z' } },
          {
            ...quietOne,
            snooze: { snoozed: true, until: '2020-01-01T00:00:00Z', allowsUrgent: true, since: '2019-12-31T00:00:00Z' },
          },
        ],
        checkedAt: '2026-10-01T12:00:00Z',
      });
      expect(tile(root, 'alpha').querySelector('[data-testid="snoozed"]')?.textContent?.trim()).toMatch(
        /^уведомления отложены до (сегодня|завтра) \d{2}:\d{2}$/,
      );
      expect(tile(root, 'quiet').querySelector('[data-testid="snoozed"]')).toBeNull();
    });

    it('follows a snooze changed from the panel at once', async () => {
      const { root, fixture } = await render([projectDto('alpha')]);
      await answer(fixture, { projects: [alpha], checkedAt: '2026-10-01T12:00:00Z' });
      expect(tile(root, 'alpha').querySelector('[data-testid="snoozed"]')).toBeNull();

      const store = TestBed.inject(ProjectsStore);
      store.applySnooze('alpha', { snoozed: true, until: null, allowsUrgent: true, since: new Date().toISOString() });
      await fixture.whenStable();
      expect(tile(root, 'alpha').querySelector('[data-testid="snoozed"]')).not.toBeNull();

      store.applySnooze('alpha', { snoozed: false });
      await fixture.whenStable();
      expect(tile(root, 'alpha').querySelector('[data-testid="snoozed"]')).toBeNull();
    });
  });
});
