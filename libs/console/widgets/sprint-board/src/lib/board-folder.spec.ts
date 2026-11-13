import { BreakpointObserver } from '@angular/cdk/layout';
import { ApplicationInitStatus, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { itemFixture, ItemsApi, type ItemQuery, type TrackerRead } from '@console/entities/item';
import { provideConsoleI18n } from '@console/shared/i18n';
import {
  emptyPersistedState,
  emptyProjectUiState,
  memoryPersistedStateStorage,
  PERSISTED_STATE_STORAGE,
  PersistedStateStore,
} from '@console/shared/persisted-state';
import type { StatusColumn } from '@console/entities/sprint';
import type { ItemSummaryDto, TrackerSprintDto, TrackerSprintListDto } from '@shared/contracts';
import { of } from 'rxjs';
import { BoardFolder, FOLDER_LANE_PAGE, type BoardFolderSpec } from './board-folder';
import { BoardFolders, boardFoldersOf, countsAfterMove } from './board-folders';
import { arrivalsLast, BoardMoves } from './board-moves';

function trackerSprint(number: number, dueOn: string | null, openCount = 0): TrackerSprintDto {
  const title = `Sprint ${String(number).padStart(2, '0')}`;
  return { number, title, dueOn, state: 'open', description: '', createdAt: '2026-11-01T00:00:00Z', closedAt: null, openCount };
}

const task = (number: number, overrides: Partial<ItemSummaryDto> = {}): ItemSummaryDto =>
  itemFixture({ key: `TC-${String(number)}`, number, title: `Task ${String(number)}`, sprint: 5, ...overrides });

const NEXT: BoardFolderSpec = { kind: 'next', sprint: trackerSprint(5, '2026-12-11', 2), openCount: 2 };
const BACKLOG: BoardFolderSpec = { kind: 'backlog', sprint: null, openCount: 0 };

/** Item reads the test answers by hand, in any order, so a stale answer can arrive after a newer one. */
class FakeItems {
  readonly calls: { slug: string; query: ItemQuery; answer: (read: TrackerRead<ItemSummaryDto[]>) => void }[] = [];
  sprintRead: TrackerRead<TrackerSprintListDto> = { ok: true, value: { sprints: [], backlogOpenCount: 0 } };

  items(slug: string, query: ItemQuery = {}): Promise<TrackerRead<ItemSummaryDto[]>> {
    return new Promise((answer) => this.calls.push({ slug, query, answer }));
  }

  async sprintList(): Promise<TrackerRead<TrackerSprintListDto>> {
    return this.sprintRead;
  }
}

// jsdom has no matchMedia; the rows' tier tooltips ask it whether the device can hover.
beforeAll(() => {
  window.matchMedia ??= ((media: string) => ({ matches: false, media }) as MediaQueryList) as typeof window.matchMedia;
});

const wide = { isMatched: () => false, observe: () => of({ matches: false, breakpoints: {} }) };

@Component({
  imports: [BoardFolder],
  template: `@if (shown()) {
    <tc-board-folder [slug]="'team-console'" [folder]="folder()" />
  }`,
})
class FolderHost {
  readonly folder = signal<BoardFolderSpec>(NEXT);
  readonly shown = signal(true);
}

@Component({
  imports: [BoardFolders],
  template: `<tc-board-folders [slug]="slug()" [initialSection]="initialSection()" />`,
})
class FoldersHost {
  readonly slug = signal('team-console');
  readonly initialSection = signal<string | null>(null);
}

async function setup<T>(
  host: new () => T,
  fake = new FakeItems(),
  storage = memoryPersistedStateStorage(),
  init?: (instance: T) => void,
) {
  await TestBed.configureTestingModule({
    imports: [host],
    providers: [
      provideConsoleI18n(),
      provideRouter([]),
      { provide: ItemsApi, useValue: fake },
      { provide: BreakpointObserver, useValue: wide },
      { provide: PERSISTED_STATE_STORAGE, useValue: storage },
    ],
  }).compileComponents();
  await TestBed.inject(ApplicationInitStatus).donePromise;
  const fixture = TestBed.createComponent(host);
  init?.(fixture.componentInstance);
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  return {
    fake,
    fixture,
    root,
    storage,
    persisted: TestBed.inject(PersistedStateStore),
    // A fake read answers in a microtask; let it land before waiting for the render.
    settle: async () => {
      await new Promise((resolve) => setTimeout(resolve));
      await fixture.whenStable();
    },
    toggle: () => root.querySelector('[data-testid="folder-toggle"]') as HTMLButtonElement,
    body: () => root.querySelector('.folder__body') as HTMLElement,
  };
}

describe('BoardFolder (#557)', () => {
  it('shows its title, demo and open count collapsed, without reading its items', async () => {
    const { root, fake, toggle, body } = await setup(FolderHost);

    expect(root.querySelector('h2')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Следующий спринт Sprint 05');
    expect(root.querySelector('.folder__meta')?.textContent).toContain('Демо 11 декабря');
    expect(root.querySelector('[data-testid="folder-open-count"]')?.textContent).toBe('2 открытые');
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(toggle().getAttribute('aria-controls')).toBe(body().id);
    expect(toggle().getAttribute('aria-label')).toBe('Показать задачи: Sprint 05');
    expect(body().hidden).toBe(true);
    expect(fake.calls).toHaveLength(0);
  });

  it('loads on Show with skeleton rows and aria-busy, then lanes with items only; Hide and Show do not reload', async () => {
    const { root, fake, toggle, body, settle } = await setup(FolderHost);
    toggle().click();
    await settle();

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.query).toEqual({ sprint: '5', state: 'open' });
    expect(body().getAttribute('aria-busy')).toBe('true');
    expect(body().querySelectorAll('.folder__skeleton')).toHaveLength(3);
    expect(root.querySelector('[role="status"]')?.textContent).toBe('Загружаем: Sprint 05…');
    expect(toggle().getAttribute('aria-expanded')).toBe('true');

    fake.calls[0]?.answer({ ok: true, value: [task(1, { status: 'blocked' }), task(2, { status: 'proposed', kind: 'bug' })] });
    await settle();
    const lanes = [...root.querySelectorAll('tc-lane')].map((lane) => lane.getAttribute('data-status'));
    expect(lanes).toEqual(['proposed', 'blocked']);
    expect(body().hasAttribute('aria-busy')).toBe(false);
    const row = root.querySelector('[data-number="2"]') as HTMLElement;
    expect(row.querySelector('a')?.getAttribute('href')).toBe('/p/team-console/t/2');
    expect(row.querySelector('[data-testid="kind"]')?.textContent).toBe('Ошибка');

    toggle().click();
    await settle();
    expect(body().hidden).toBe(true);
    expect(root.querySelector('tc-lane')).not.toBeNull();
    toggle().click();
    await settle();
    expect(fake.calls).toHaveLength(1);
  });

  it('shows the next-sprint and backlog empty states', async () => {
    const { root, fake, fixture, toggle, settle } = await setup(FolderHost);
    toggle().click();
    await settle();
    fake.calls[0]?.answer({ ok: true, value: [] });
    await settle();
    expect(root.querySelector('[data-testid="folder-empty"]')?.textContent).toContain(
      'Перенесите сюда задачи из бэклога кнопкой ⋯ у задачи.',
    );

    fixture.componentInstance.shown.set(false);
    await settle();
    fixture.componentInstance.folder.set(BACKLOG);
    fixture.componentInstance.shown.set(true);
    await settle();
    toggle().click();
    await settle();
    expect(fake.calls[1]?.query).toEqual({ sprint: 'none', state: 'open' });
    fake.calls[1]?.answer({ ok: true, value: [] });
    await settle();
    expect(root.querySelector('h2')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Бэклог Задачи без спринта');
    expect(root.querySelector('[data-testid="folder-empty"]')?.textContent).toContain('В бэклоге пусто');
  });

  it('shows an alert with Try again on an error, and loads again from it', async () => {
    const { root, fake, toggle, settle } = await setup(FolderHost);
    toggle().click();
    await settle();
    fake.calls[0]?.answer({ ok: false, reason: 'error' });
    await settle();
    const alert = root.querySelector('[data-testid="folder-error"]') as HTMLElement;
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain('Не удалось загрузить: Sprint 05');

    (alert.querySelector('button') as HTMLButtonElement).click();
    await settle();
    expect(fake.calls).toHaveLength(2);
    fake.calls[1]?.answer({ ok: true, value: [task(3)] });
    await settle();
    expect(root.querySelector('[data-number="3"]')).not.toBeNull();
  });

  it('waits offline and loads again on the online event, not before', async () => {
    const { root, fake, fixture, toggle, settle } = await setup(FolderHost);
    toggle().click();
    await settle();
    fake.calls[0]?.answer({ ok: false, reason: 'offline' });
    await settle();
    expect(root.querySelector('[data-testid="folder-offline"]')).not.toBeNull();

    const folder = fixture.debugElement.children[0]?.componentInstance as BoardFolder;
    expect(folder.state().kind).toBe('offline');
    folder.onOnline();
    await settle();
    expect(fake.calls).toHaveLength(2);
    folder.onOnline();
    expect(fake.calls).toHaveLength(2);
  });

  it('drops an answer that arrives after the folder is gone or a newer load', async () => {
    const { root, fake, fixture, toggle, settle } = await setup(FolderHost);
    toggle().click();
    await settle();
    fake.calls[0]?.answer({ ok: false, reason: 'error' });
    await settle();
    (root.querySelector('[data-testid="folder-error"] button') as HTMLButtonElement).click();
    await settle();
    const folder = fixture.debugElement.children[0]?.componentInstance as BoardFolder;
    folder.onOnline();
    expect(fake.calls).toHaveLength(2);

    fixture.componentInstance.shown.set(false);
    await settle();
    fake.calls[1]?.answer({ ok: true, value: [task(4)] });
    await settle();
    expect(folder.state().kind).toBe('loading');
  });

  it('shows 30 rows a lane, then «Show 30 more · N left», moving focus to the first new row', async () => {
    const { root, fake, toggle, settle } = await setup(FolderHost);
    toggle().click();
    await settle();
    fake.calls[0]?.answer({ ok: true, value: Array.from({ length: 75 }, (_, index) => task(index + 1)) });
    await settle();
    const rows = () => root.querySelectorAll('tc-lane tc-list-row');
    const more = () => root.querySelector('[data-testid="folder-more"]') as HTMLButtonElement | null;
    expect(rows()).toHaveLength(FOLDER_LANE_PAGE);
    expect(more()?.textContent?.trim()).toBe('Показать ещё 30 · осталось 45');

    more()?.click();
    await settle();
    expect(rows()).toHaveLength(60);
    expect(document.activeElement).toBe(rows()[30]?.querySelector('a'));
    expect(more()?.textContent?.trim()).toBe('Показать ещё 15 · осталось 15');
    more()?.click();
    await settle();
    expect(rows()).toHaveLength(75);
    expect(more()).toBeNull();
  });
});

describe('BoardFolders (#557)', () => {
  it('lists every open future sprint by demo date, then the backlog, with the API counts', () => {
    const list: TrackerSprintListDto = {
      sprints: [trackerSprint(4, '2026-11-27', 9), trackerSprint(6, '2026-12-25', 1), trackerSprint(5, '2026-12-11', 3)],
      backlogOpenCount: 12,
    };
    expect(boardFoldersOf(list).map((folder) => [folder.kind, folder.sprint?.number ?? null, folder.openCount])).toEqual([
      ['next', 5, 3],
      ['later', 6, 1],
      ['backlog', null, 12],
    ]);
  });

  it('says there is no next sprint, with Create a sprint, and keeps the backlog folder', async () => {
    const fake = new FakeItems();
    fake.sprintRead = { ok: true, value: { sprints: [trackerSprint(4, '2026-11-27')], backlogOpenCount: 2 } };
    const { root, settle } = await setup(FoldersHost, fake);
    await settle();
    expect(root.querySelector('[data-testid="no-next"]')?.textContent).toContain('Следующего спринта пока нет.');
    expect(root.querySelector('[data-testid="folders-create-sprint"]')).not.toBeNull();
    expect([...root.querySelectorAll('tc-board-folder')].map((folder) => folder.getAttribute('data-folder'))).toEqual([
      'backlog',
    ]);
  });

  it('shows the project-empty state without sprints or open tasks', async () => {
    const { root, settle } = await setup(FoldersHost);
    await settle();
    expect(root.querySelector('[data-testid="project-empty"]')?.textContent).toContain('Задач пока нет');
    expect(root.querySelector('tc-board-folder')).toBeNull();
  });

  it('shows the list error with Try again, and reads the list again on the online event when offline', async () => {
    const fake = new FakeItems();
    fake.sprintRead = { ok: false, reason: 'offline' };
    const { root, settle } = await setup(FoldersHost, fake);
    await settle();
    expect(root.querySelector('[data-testid="folders-error"]')?.getAttribute('role')).toBe('alert');

    fake.sprintRead = { ok: true, value: { sprints: [trackerSprint(4, '2026-11-27'), trackerSprint(5, null)], backlogOpenCount: 0 } };
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(root.querySelector('[data-testid="folders-error"]')).toBeNull();
    expect(root.querySelectorAll('tc-board-folder')).toHaveLength(2);
  });
});

describe('BoardFolders, remembered folders and the ?section= deep link (#562)', () => {
  // Sprint 4 is the current sprint (earliest demo date) and never a folder; Sprint 5 is "next".
  const list = (): TrackerSprintListDto => ({
    sprints: [trackerSprint(4, '2026-11-27', 1), trackerSprint(5, '2026-12-11', 2)],
    backlogOpenCount: 3,
  });
  const toggles = (root: HTMLElement) => [...root.querySelectorAll('[data-testid="folder-toggle"]')];

  it('opens the folders remembered from a previous visit and loads them by itself', async () => {
    const stored = memoryPersistedStateStorage(
      JSON.stringify({
        ...emptyPersistedState(),
        projects: { 'team-console': { ...emptyProjectUiState(), boardFolders: ['sprint:5'] } },
      }),
    );
    const fake = new FakeItems();
    fake.sprintRead = { ok: true, value: list() };
    const { root, fake: items, settle } = await setup(FoldersHost, fake, stored);
    await settle();

    expect(toggles(root).map((toggle) => toggle.getAttribute('aria-expanded'))).toEqual(['true', 'false']);
    expect(items.calls).toHaveLength(1);
    expect(items.calls[0]?.query).toEqual({ sprint: '5', state: 'open' });
  });

  it('persists an open or hidden folder by its key, as a set, so a reload keeps it', async () => {
    const fake = new FakeItems();
    fake.sprintRead = { ok: true, value: list() };
    const { root, settle, persisted } = await setup(FoldersHost, fake);
    await settle();

    (toggles(root)[1] as HTMLButtonElement).click();
    await settle();
    persisted.flush();
    expect(persisted.projectState('team-console')?.boardFolders).toEqual(['backlog']);

    (toggles(root)[1] as HTMLButtonElement).click();
    await settle();
    persisted.flush();
    expect(persisted.projectState('team-console')?.boardFolders).toEqual([]);
  });

  it('opens the ?section=backlog folder, loads it and focuses its heading', async () => {
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    const fake = new FakeItems();
    fake.sprintRead = { ok: true, value: list() };
    const { root, fake: items, settle } = await setup(FoldersHost, fake, memoryPersistedStateStorage(), (host) =>
      host.initialSection.set('backlog'),
    );
    await settle();

    const [nextToggle, backlogToggle] = toggles(root);
    expect(nextToggle?.getAttribute('aria-expanded')).toBe('false');
    expect(backlogToggle?.getAttribute('aria-expanded')).toBe('true');
    expect(items.calls[0]?.query).toEqual({ sprint: 'none', state: 'open' });

    const backlogHeading = root.querySelector('[data-folder="backlog"] h2') as HTMLElement;
    expect(scrollIntoView).toHaveBeenCalled();
    expect(document.activeElement).toBe(backlogHeading);
  });

  it('ignores a `?section=` other than next or backlog', async () => {
    const fake = new FakeItems();
    fake.sprintRead = { ok: true, value: list() };
    const { root, settle } = await setup(FoldersHost, fake, memoryPersistedStateStorage(), (host) =>
      host.initialSection.set('later'),
    );
    await settle();
    expect(toggles(root).map((toggle) => toggle.getAttribute('aria-expanded'))).toEqual(['false', 'false']);
  });
});

describe('Moves on the board (#558)', () => {
  const issue = (number: number) => ({ number }) as StatusColumn['issues'][number];

  it('puts tasks moved in at the end of their lane, in the order they came', () => {
    const lanes: StatusColumn[] = [{ status: 'approved', issues: [issue(1), issue(2), issue(3), issue(4)] }];
    expect(arrivalsLast(lanes, [3, 1])[0]?.issues.map((row) => row.number)).toEqual([2, 4, 3, 1]);
  });

  it('moves one open count from the source folder to the target', () => {
    const list: TrackerSprintListDto = { sprints: [trackerSprint(4, '2026-11-27', 2), trackerSprint(5, null, 1)], backlogOpenCount: 3 };
    const after = countsAfterMove(list, null, 5);
    expect(after.sprints.map((sprint) => sprint.openCount)).toEqual([2, 2]);
    expect(after.backlogOpenCount).toBe(2);
  });

  it('gives every row its ⋯, drops a row that left with focus on the next ⋯, and shows a refused move as an alert', async () => {
    const { root, fake, toggle, settle } = await setup(FolderHost);
    toggle().click();
    await settle();
    fake.calls[0]?.answer({ ok: true, value: [task(2), task(3), task(4)] });
    await settle();
    const button = (n: number) => root.querySelector(`[data-move="${String(n)}"]`) as HTMLButtonElement | null;
    expect(button(3)?.getAttribute('aria-label')).toBe('Переместить TC-3: Task 3');
    expect(button(3)?.getAttribute('aria-haspopup')).toBe('menu');

    const moves = TestBed.inject(BoardMoves);
    button(3)?.focus();
    moves.handlers.moved({ item: { ...task(3), sprint: null }, from: 5, to: null, isUndo: false });
    await settle();
    expect(root.querySelector('[data-number="3"]')).toBeNull();
    expect(document.activeElement).toBe(button(4));

    moves.handlers.moved({ item: task(1), from: null, to: 5, isUndo: false });
    await settle();
    const rows = [...root.querySelectorAll('tc-list-row')].map((row) => row.getAttribute('data-number'));
    expect(rows).toEqual(['2', '4', '1']);

    moves.handlers.failed(
      { failure: { kind: 'forbidden', field: null, retryAfter: null }, retry: async () => undefined },
      task(2),
    );
    await settle();
    const alert = root.querySelector('[data-testid="tracker-failure"]');
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert?.textContent).toContain('Менять задачи может только владелец');
    expect(root.querySelector('[data-number="2"]')).not.toBeNull();
  });
});
