import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationInitStatus } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ProjectsStore } from '@console/entities/project';
import { TeamStatusStore } from '@console/entities/team-run';
import { provideConsoleI18n } from '@console/shared/i18n';
import type { ProjectDto, SnoozeDto, TeamStatusDto } from '@shared/contracts';
import { SnoozeCommands, type SnoozeOutcome } from './snooze-commands';
import { snoozeUrl } from './snooze.client';

const TARGET = { slug: 'tc', name: 'Team Console' };
const NOW = new Date(2026, 9, 5, 14, 30).getTime();
const URL = snoozeUrl('tc');

const PROJECT: ProjectDto = {
  slug: 'tc',
  repo: 'geeera/team-console',
  displayName: 'Team Console',
  routineId: null,
  addedAt: '2026-09-30T00:00:00Z',
  archivedAt: null,
  snooze: { snoozed: false },
};

const STATUS: TeamStatusDto = {
  state: 'running',
  pausedAt: null,
  runLogUrl: null,
  ownerConnected: true,
  environment: 'local',
  snooze: { snoozed: false },
  checkedAt: '2026-10-05T11:30:00.000Z',
  sprint: null,
  progress: null,
  calendar: null,
  pendingRequests: 0,
  slots: (['pm', 'dev', 'qa'] as const).map((slot) => ({
    slot,
    setup: 'missing',
    secrets: { token: 't', routine: 'r' },
    lastRun: null,
    lock: null,
  })),
};

function overlay(): HTMLElement {
  return document.querySelector('.cdk-overlay-container') as HTMLElement;
}

function dialog(): HTMLElement | null {
  return overlay()?.querySelector('tc-sheet-container') ?? null;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const text = (element: Element | null | undefined): string =>
  element?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

describe('SnoozeCommands', () => {
  let commands: SnoozeCommands;
  let http: HttpTestingController;
  let projects: ProjectsStore;
  let status: TeamStatusStore;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), provideConsoleI18n()],
    });
    await TestBed.inject(ApplicationInitStatus).donePromise;
    http = TestBed.inject(HttpTestingController);
    commands = TestBed.inject(SnoozeCommands);
    commands.now = () => NOW;
    projects = TestBed.inject(ProjectsStore);
    projects.upsert(PROJECT);
    status = TestBed.inject(TeamStatusStore);
    status.slug.set('tc');
    status.status.set(STATUS);
  });

  afterEach(() => {
    http.verify();
    overlay()?.remove();
  });

  function press(selector: string): void {
    const element = dialog()?.querySelector<HTMLElement>(selector);
    if (element === null || element === undefined) {
      throw new Error(`no ${selector} in the dialog`);
    }
    element.click();
  }

  it('opens a plain dialog: four choices, until morning picked, urgent ones on by default, no confirmation', async () => {
    const pending = commands.snooze(TARGET);
    await settle();

    const open = dialog() as HTMLElement;
    expect(open.getAttribute('role')).toBe('dialog');
    expect(text(open.querySelector('.tc-sheet__title'))).toBe('Отложить уведомления Team Console');
    expect(text(open.querySelector('.snooze__body'))).toBe(
      'Пуши по этому проекту — на всех ваших устройствах.',
    );
    expect(text(open)).not.toMatch(/дайджест/i);
    expect(text(open.querySelector('legend'))).toBe('На сколько');
    const radios = [...open.querySelectorAll<HTMLInputElement>('input[type=radio]')];
    expect(radios.map((radio) => text(radio.closest('label')))).toEqual([
      'На час',
      'До утра (9:00)',
      'На неделю',
      'Пока не включу',
    ]);
    expect(radios.filter((radio) => radio.checked).map((radio) => radio.value)).toEqual(['morning']);
    const urgent = open.querySelector('[data-testid="snooze-urgent"]') as HTMLInputElement;
    expect(urgent.checked).toBe(true);
    expect(text(document.getElementById(urgent.getAttribute('aria-describedby') ?? ''))).toBe(
      'Команда остановилась сама, нужно решение о релизе.',
    );

    press('.snooze__actions button[type=button]');
    await expect(pending).resolves.toBeNull();
  });

  it('stores the choice, updates the sidebar and the panel, and reports it as a moss note', async () => {
    const pending = commands.snooze(TARGET);
    await settle();
    press('[data-testid="snooze-week"]');
    press('[data-testid="snooze-urgent"]');
    press('[data-testid="snooze-ok"]');

    const request = http.expectOne(URL);
    expect(request.request.method).toBe('PUT');
    const until = new Date(2026, 9, 12, 9).toISOString();
    expect(request.request.body).toEqual({ until, allowsUrgent: false });
    const stored: SnoozeDto = {
      snoozed: true,
      until,
      allowsUrgent: false,
      since: new Date(NOW).toISOString(),
    };
    request.flush(stored);

    const outcome = (await pending) as SnoozeOutcome;
    expect(outcome.tone).toBe('positive');
    expect(outcome.verb).toBe('Уведомления Team Console отложены до 12 октября, 09:00');
    expect(projects.bySlug('tc')?.snooze).toEqual(stored);
    expect(status.status()?.snooze).toEqual(stored);
    await settle();
    expect(dialog()).toBeNull();
  });

  it('until turned back on says so', async () => {
    const pending = commands.snooze(TARGET);
    await settle();
    press('[data-testid="snooze-forever"]');
    press('[data-testid="snooze-ok"]');
    const request = http.expectOne(URL);
    expect(request.request.body).toEqual({ until: null, allowsUrgent: true });
    request.flush({ snoozed: true, until: null, allowsUrgent: true, since: new Date(NOW).toISOString() });
    expect((await pending)?.verb).toBe('Уведомления Team Console отложены, пока не включите');
  });

  it('a failed save keeps the dialog open with the reason and Try again, which repeats the request', async () => {
    const pending = commands.snooze(TARGET);
    await settle();
    press('[data-testid="snooze-hour"]');
    press('[data-testid="snooze-ok"]');
    http
      .expectOne(URL)
      .flush({ type: 'x', title: 'down', status: 502 }, { status: 502, statusText: 'Bad Gateway' });
    await settle();

    expect(text(dialog()?.querySelector('[role="alert"]'))).toBe(
      'Не удалось сохранить: сервер не ответил. Ничего не изменено.',
    );
    expect(text(dialog()?.querySelector('[data-testid="snooze-ok"]'))).toBe('Повторить');
    expect(projects.bySlug('tc')?.snooze).toEqual({ snoozed: false });

    press('[data-testid="snooze-ok"]');
    const retry = http.expectOne(URL);
    expect(retry.request.body).toEqual({
      until: new Date(NOW + 3_600_000).toISOString(),
      allowsUrgent: true,
    });
    retry.flush({
      snoozed: true,
      until: retry.request.body.until,
      allowsUrgent: true,
      since: new Date(NOW).toISOString(),
    });
    expect((await pending)?.verb).toBe('Уведомления Team Console отложены до сегодня 15:30');
  });

  it('offline: the dialog says so and nothing changes', async () => {
    const pending = commands.snooze(TARGET);
    await settle();
    press('[data-testid="snooze-ok"]');
    http.expectOne(URL).error(new ProgressEvent('error'), { status: 0 });
    await settle();
    expect(text(dialog()?.querySelector('[role="alert"]'))).toBe('Нет сети. Ничего не изменено.');
    press('.snooze__actions button[type=button]');
    await expect(pending).resolves.toBeNull();
  });

  it('turns notifications back on in one tap, with no dialog', async () => {
    const snoozed: SnoozeDto = {
      snoozed: true,
      until: null,
      allowsUrgent: true,
      since: '2026-10-05T10:00:00.000Z',
    };
    projects.applySnooze('tc', snoozed);
    status.applySnooze('tc', snoozed);

    const pending = commands.turnBackOn(TARGET);
    await settle();
    expect(dialog()).toBeNull();
    const request = http.expectOne(URL);
    expect(request.request.method).toBe('DELETE');
    request.flush({ snoozed: false });

    expect(await pending).toMatchObject({
      tone: 'positive',
      verb: 'Уведомления Team Console снова включены',
    });
    expect(projects.bySlug('tc')?.snooze).toEqual({ snoozed: false });
    expect(status.status()?.snooze).toEqual({ snoozed: false });
  });

  it('a failed Turn back on changes nothing and says so in the note', async () => {
    const snoozed: SnoozeDto = {
      snoozed: true,
      until: null,
      allowsUrgent: true,
      since: '2026-10-05T10:00:00.000Z',
    };
    projects.applySnooze('tc', snoozed);
    const pending = commands.turnBackOn(TARGET);
    http.expectOne(URL).flush('', { status: 500, statusText: 'x' });
    expect(await pending).toMatchObject({
      tone: 'warning',
      verb: 'Не удалось включить уведомления Team Console: сервер не ответил. Ничего не изменено.',
    });
    expect(projects.bySlug('tc')?.snooze).toEqual(snoozed);
  });
});
