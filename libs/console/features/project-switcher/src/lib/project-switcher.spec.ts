import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationInitStatus, Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { NEEDS_YOU_URL, NeedsYouCounts, PROJECTS_URL, ProjectsStore } from '@console/entities/project';
import { provideConsoleI18n } from '@console/shared/i18n';
import {
  emptyPersistedState,
  memoryPersistedStateStorage,
  PERSISTED_STATE_STORAGE,
  PersistedStateStore,
} from '@console/shared/persisted-state';
import { ProjectDto } from '@shared/contracts';
import { ProjectSwitcher } from './project-switcher';

@Component({ template: '' })
class Blank {}

const project = (slug: string, displayName: string): ProjectDto => ({
  slug,
  repo: `geeera/${slug}`,
  displayName,
  routineId: null,
  addedAt: '2026-09-29T00:00:00.000Z',
  archivedAt: null,
});

describe('ProjectSwitcher', () => {
  let fixture: ComponentFixture<ProjectSwitcher>;
  let http: HttpTestingController;
  let router: Router;
  let state: PersistedStateStore;

  const root = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const rowTitles = (): string[] =>
    Array.from(root().querySelectorAll('[tc-row-title]')).map((el) => el.textContent?.trim() ?? '');
  const rowButton = (title: string): HTMLButtonElement =>
    Array.from(root().querySelectorAll<HTMLButtonElement>('button.tc-list-row__surface')).find((button) =>
      button.textContent?.includes(title),
    ) as HTMLButtonElement;

  async function setup(stored = JSON.stringify(emptyPersistedState())) {
    await TestBed.configureTestingModule({
      imports: [ProjectSwitcher],
      providers: [
        provideRouter([{ path: '**', component: Blank }]),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideConsoleI18n(),
        { provide: PERSISTED_STATE_STORAGE, useValue: memoryPersistedStateStorage(stored) },
      ],
    }).compileComponents();
    await TestBed.inject(ApplicationInitStatus).donePromise;
    http = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
    state = TestBed.inject(PersistedStateStore);

    const ready = TestBed.inject(ProjectsStore).ready();
    http
      .expectOne(PROJECTS_URL)
      .flush([project('reader', 'Reader'), project('tc', 'Team Console'), project('sx', 'Sheltrix')]);
    await ready;
    const counts = TestBed.inject(NeedsYouCounts).refresh();
    http.expectOne(NEEDS_YOU_URL).flush([{ project: 'tc' }, { project: 'tc' }, { project: 'tc' }]);
    await counts;

    fixture = TestBed.createComponent(ProjectSwitcher);
    await fixture.whenStable();
  }

  afterEach(() => http.verify());

  it('lists active projects by name with the needs-you badge, no disclosure while nothing is pinned', async () => {
    await setup();

    expect(rowTitles()).toEqual(['Reader', 'Sheltrix', 'Team Console']);
    expect(root().querySelector('.switcher__more')).toBeNull();
    const chip = rowButton('Team Console').querySelector('tc-chip') as HTMLElement;
    expect(chip.textContent).toContain('3');
    expect(chip.querySelector('.tc-sr-only')?.textContent).toBe('Ждут вас: 3');
    expect(rowButton('Reader').querySelector('tc-chip')).toBeNull();
  });

  it('puts pinned projects first in pin order and folds the rest behind a disclosure', async () => {
    await setup(JSON.stringify({ ...emptyPersistedState(), pinned: ['sx', 'tc'], collapsed: true }));

    expect(rowTitles()).toEqual(['Sheltrix', 'Team Console']);
    const more = root().querySelector('.switcher__more') as HTMLButtonElement;
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(more.textContent?.trim()).toBe('Ещё 1');

    more.click();
    await fixture.whenStable();

    expect(rowTitles()).toEqual(['Sheltrix', 'Team Console', 'Reader']);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(state.collapsed()).toBe(false);
  });

  it('pins and unpins from the row action without switching', async () => {
    await setup();
    const navigate = vi.spyOn(router, 'navigateByUrl');

    (rowButton('Sheltrix').parentElement?.querySelector('[tc-row-action]') as HTMLButtonElement).click();
    await fixture.whenStable();

    expect(state.pinned()).toEqual(['sx']);
    expect(rowTitles()[0]).toBe('Sheltrix');
    expect(navigate).not.toHaveBeenCalled();
    const unpin = root().querySelector('[tc-row-action][aria-pressed="true"]') as HTMLButtonElement;
    expect(unpin.getAttribute('aria-label')).toBe('Открепить Sheltrix');
  });

  it('switching opens the project’s last screen and remembers it as active', async () => {
    await setup(
      JSON.stringify({
        ...emptyPersistedState(),
        projects: { sx: { lastPath: 'artifacts?type=decisions', scroll: {}, chatDraft: '' } },
      }),
    );
    const switched = vi.fn();
    fixture.componentInstance.switched.subscribe(switched);

    rowButton('Sheltrix').click();
    await fixture.whenStable();

    expect(router.url).toBe('/p/sx/artifacts?type=decisions');
    expect(state.activeSlug()).toBe('sx');
    expect(switched).toHaveBeenCalledWith('sx');
    expect(rowButton('Sheltrix').getAttribute('aria-current')).toBe('true');

    rowButton('Reader').click();
    await fixture.whenStable();
    expect(router.url).toBe('/p/reader/questions');
  });

  it('marks a snoozed project with the struck bell and the words, and drops it once turned back on (#221)', async () => {
    await setup();
    const store = TestBed.inject(ProjectsStore);
    store.applySnooze('sx', { snoozed: true, until: null, allowsUrgent: true, since: '2026-10-05T10:00:00.000Z' });
    store.applySnooze('reader', {
      snoozed: true,
      until: '2020-01-01T00:00:00.000Z',
      allowsUrgent: true,
      since: '2019-12-31T00:00:00.000Z',
    });
    await fixture.whenStable();

    const mark = rowButton('Sheltrix').querySelector('[data-testid="switcher-snoozed"]') as HTMLElement;
    expect(mark.textContent?.trim()).toBe('уведомления отложены');
    expect(mark.querySelector('tc-icon')?.getAttribute('name')).toBe('bell-off');
    // An expired snooze is no snooze: no bell.
    expect(rowButton('Reader').querySelector('[data-testid="switcher-snoozed"]')).toBeNull();
    expect(rowButton('Team Console').querySelector('[data-testid="switcher-snoozed"]')).toBeNull();

    store.applySnooze('sx', { snoozed: false });
    await fixture.whenStable();
    expect(rowButton('Sheltrix').querySelector('[data-testid="switcher-snoozed"]')).toBeNull();
  });
});
