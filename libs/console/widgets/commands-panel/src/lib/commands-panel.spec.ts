import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationInitStatus, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { TeamStatusStore } from '@console/entities/team-run';
import { SprintControls } from '@console/features/sprint-controls';
import { TeamCommands, type CommandOutcome } from '@console/features/team-commands';
import { NetworkStatus } from '@console/shared/api';
import { provideConsoleI18n } from '@console/shared/i18n';
import { Toaster } from '@console/shared/ui';
import type { TeamStatusDto } from '@shared/contracts';
import { CommandsPanel, type CommandsProject } from './commands-panel';
import { PausedBanner } from './paused-banner';

const PROJECT: CommandsProject = { slug: 'tc', name: 'Team Console', repo: 'geeera/team-console' };

function status(overrides: Partial<TeamStatusDto> = {}): TeamStatusDto {
  const secrets = (slot: string) => ({ token: `SLOT_TOKEN_TC_${slot}`, routine: `SLOT_ROUTINE_TC_${slot}` });
  return {
    state: 'running',
    pausedAt: null,
    runLogUrl: 'https://github.com/geeera/team-console/issues/22',
    ownerConnected: true,
    environment: 'stage',
    checkedAt: new Date().toISOString(),
    sprint: null,
    progress: null,
    calendar: null,
    slots: [
      {
        slot: 'pm',
        setup: 'present',
        secrets: secrets('PM'),
        lastRun: { at: new Date().toISOString(), state: 'finished' },
        lock: null,
      },
      {
        slot: 'dev',
        setup: 'present',
        secrets: secrets('DEV'),
        lastRun: null,
        lock: {
          kind: 'started',
          runId: 'r1',
          since: new Date().toISOString(),
          until: new Date(Date.now() + 3_600_000).toISOString(),
        },
      },
      { slot: 'qa', setup: 'missing', secrets: secrets('QA'), lastRun: null, lock: null },
    ],
    ...overrides,
  };
}

@Component({
  imports: [CommandsPanel, PausedBanner],
  template: `<tc-paused-banner [project]="project" /><tc-commands-panel [project]="project" />`,
})
class Host {
  readonly project = PROJECT;
}

describe('CommandsPanel', () => {
  let commands: {
    pause: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
    run: ReturnType<typeof vi.fn>;
  };
  let sprintControls: { moveDemo: ReturnType<typeof vi.fn>; startNext: ReturnType<typeof vi.fn> };
  let online: ReturnType<typeof signal<boolean>>;
  let toasts: string[];

  async function render(initial: TeamStatusDto) {
    const done: CommandOutcome = {
      tone: 'positive',
      verb: 'Запрошено: разработка',
      detail: null,
      runLogUrl: null,
      at: new Date().toISOString(),
    };
    commands = {
      pause: vi.fn(async () => done),
      resume: vi.fn(async () => done),
      run: vi.fn(async () => done),
    };
    sprintControls = { moveDemo: vi.fn(async () => done), startNext: vi.fn(async () => done) };
    online = signal(true);
    toasts = [];
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideConsoleI18n(),
        { provide: TeamCommands, useValue: commands },
        { provide: SprintControls, useValue: sprintControls },
        { provide: NetworkStatus, useValue: { online } },
        { provide: Toaster, useValue: { show: (text: string) => toasts.push(text) } },
      ],
    }).compileComponents();
    await TestBed.inject(ApplicationInitStatus).donePromise;
    const store = TestBed.inject(TeamStatusStore);
    store.slug.set('tc');
    store.status.set(initial);
    store.phase.set('ready');
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    return { fixture, root: fixture.nativeElement as HTMLElement, store };
  }

  const text = (element: Element | null | undefined): string =>
    element?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

  it('says the state in words and draws one row per slot with its line or why it is off', async () => {
    const { root } = await render(status());
    expect(text(root.querySelector('[data-testid="team-state"]'))).toBe('В работе');
    expect(root.querySelector('[data-testid="paused-banner"]')).toBeNull();

    const pm = root.querySelector('[data-slot="pm"]');
    expect(text(pm?.querySelector('.cmd__line'))).toMatch(/^Последний: сегодня \d\d:\d\d, успешно$/);
    expect(pm?.querySelector('button')?.getAttribute('aria-disabled')).toBeNull();

    const dev = root.querySelector('[data-slot="dev"] button');
    expect(dev?.getAttribute('aria-disabled')).toBe('true');
    expect(text(root.querySelector('[data-slot="dev"] .cmd__line'))).toMatch(
      /^Идёт с \d\d:\d\d\. Второй запуск — не раньше/,
    );

    const qa = root.querySelector('[data-slot="qa"] button') as HTMLButtonElement;
    expect(qa.getAttribute('aria-disabled')).toBe('true');
    const why = root.querySelector(`#${qa.getAttribute('aria-describedby')?.split(' ')[0]}`);
    expect(text(why)).toBe('Не настроено: у этой рутины нет токена запуска');
    qa.click();
    expect(commands.run).not.toHaveBeenCalled();
  });

  it('#218: the status card shows the sprint, its freeze and progress; the Sprint group moves the demo', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const { fixture, root } = await render(
      status({
        sprint: {
          number: 4,
          title: 'Sprint 04',
          due: '2026-10-14',
          freeze: { from: '2026-10-12', to: '2026-10-14' },
          next: { number: 5, title: 'Sprint 05', due: '2026-10-28' },
        },
        progress: { done: 3, total: 8 },
        calendar: { today: today < '2026-10-12' ? today : '2026-10-05', freezeDays: 2, nextTitle: 'Sprint 06' },
      }),
    );
    expect(text(root.querySelector('[data-testid="status-sprint"]'))).toMatch(
      /^Sprint 04 · демо 14 октября заморозка 12\s?–\s?14 октября$/,
    );
    expect(text(root.querySelector('[data-testid="status-progress"]'))).toBe('3 из 8');
    expect(text(root.querySelector('[data-sprint="next"] .cmd__line'))).toBe('Sprint 05 уже создан: демо 28 октября');
    expect(root.querySelector('[data-testid="sprint-next"]')).toBeNull();
    const move = root.querySelector('[data-testid="sprint-demo"]') as HTMLButtonElement;
    expect(move.getAttribute('aria-label')).toBe('Перенести демо Sprint 04');
    move.click();
    await fixture.whenStable();
    expect(sprintControls.moveDemo).toHaveBeenCalledWith({ slug: 'tc', name: 'Team Console' });
  });

  it('#218: without the GitHub connection the sprint commands say why and do nothing', async () => {
    const { root } = await render(
      status({ ownerConnected: false, calendar: { today: '2026-10-05', freezeDays: 2, nextTitle: 'Sprint 01' } }),
    );
    expect(text(root.querySelector('[data-testid="status-sprint"]'))).toBe('Текущего спринта нет');
    const next = root.querySelector('[data-testid="sprint-next"]') as HTMLButtonElement;
    expect(next.getAttribute('aria-disabled')).toBe('true');
    next.click();
    expect(sprintControls.startNext).not.toHaveBeenCalled();
  });

  it('shows the setup card for the missing slot only, with copyable commands for this checkout and the token warning', async () => {
    const { fixture, root } = await render(status());
    const card = root.querySelector('[data-testid="setup-card"]') as HTMLElement;
    expect(text(card.querySelector('h4'))).toBe('Запуск отсюда не настроен: проверка (QA)');
    const how = card.querySelector('[aria-expanded]') as HTMLButtonElement;
    expect(how.getAttribute('aria-expanded')).toBe('false');
    how.click();
    await fixture.whenStable();
    expect([...card.querySelectorAll('code')].map(text)).toEqual([
      'npx wrangler secret put SLOT_ROUTINE_TC_QA --env stage --config apps/api/wrangler.jsonc',
      'npx wrangler secret put SLOT_TOKEN_TC_QA --env stage --config apps/api/wrangler.jsonc',
    ]);
    expect(text(card)).toContain('в папке team-console, в терминале, где уже выполнен npx wrangler login');
    expect(text(card.querySelector('.cp-warn'))).toBe(
      'Вставляйте токен только в это скрытое поле — никогда в чат, issue или агенту. Если он утёк, перевыпустите его в Claude Code: старый перестанет работать.',
    );
  });

  it('runs a slot through one confirmation and shows the result note with focus on it', async () => {
    const { fixture, root } = await render(status());
    (root.querySelector('[data-slot="pm"] button') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(commands.run).toHaveBeenCalledWith({ slug: 'tc', name: 'Team Console' }, 'pm');
    const note = root.querySelector('.cp-result') as HTMLElement;
    expect(text(note)).toContain('Запрошено: разработка');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.activeElement).toBe(note);
  });

  it('pause needs the GitHub connection; Run now does not', async () => {
    const { root } = await render(status({ ownerConnected: false }));
    const team = root.querySelector('[data-testid="team-command"]') as HTMLButtonElement;
    expect(team.getAttribute('aria-disabled')).toBe('true');
    expect(text(root.querySelector('.cmd--team .cmd__why'))).toBe('Нет права записи');
    team.click();
    expect(commands.pause).not.toHaveBeenCalled();
    expect(root.querySelector('[data-slot="pm"] button')?.getAttribute('aria-disabled')).toBeNull();
    expect(text(root.querySelector('.cp-note'))).toContain('geeera/team-console');
  });

  it('paused by the owner: a banner with Resume, the team row resumes, run rows say resume first', async () => {
    const { fixture, root } = await render(
      status({ state: 'paused-by-owner', pausedAt: new Date().toISOString() }),
    );
    const banner = root.querySelector('[data-testid="paused-banner"]') as HTMLElement;
    expect(banner.classList).toContain('tc-banner--warning');
    expect(text(banner)).toMatch(
      /^Team Console на паузе с \d\d:\d\d\. Прогоны по расписанию сразу завершаются без работы\./,
    );
    expect(text(root.querySelector('[data-slot="pm"] .cmd__why'))).toBe('Сначала возобновите разработку');

    (root.querySelector('[data-testid="team-command"]') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(commands.resume).toHaveBeenCalledTimes(1);

    (banner.querySelector('[data-testid="banner-resume"]') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(commands.resume).toHaveBeenCalledTimes(2);
    expect(toasts).toEqual(['Запрошено: разработка']);
  });

  it('paused by the team: a clay banner with the run log', async () => {
    const { root } = await render(status({ state: 'paused-by-team' }));
    const banner = root.querySelector('[data-testid="paused-banner"]') as HTMLElement;
    expect(banner.classList).toContain('tc-banner--danger');
    expect(banner.querySelector('a')?.getAttribute('href')).toBe(
      'https://github.com/geeera/team-console/issues/22',
    );
    expect(text(root.querySelector('[data-testid="team-state"]'))).toBe(
      'Остановилась сама: три прогона подряд упали',
    );
  });

  it('offline: every command is off and says so', async () => {
    const { fixture, root } = await render(status());
    online.set(false);
    await fixture.whenStable();
    expect(root.querySelector('[data-testid="team-command"]')?.getAttribute('aria-disabled')).toBe('true');
    expect(text(root.querySelector('[data-slot="pm"] .cmd__why'))).toBe('Нет сети');
    expect(text(root.querySelector('.cp-note'))).toMatch(/^Нет сети\. Статус на/);
  });

  it('without a status: loading, then an error with Try again; commands are not drawn', async () => {
    const { fixture, root, store } = await render(status());
    store.status.set(null);
    store.phase.set('error');
    store.problem.set({
      status: 502,
      slug: 'github-unavailable',
      problem: null,
      extensions: {},
      retryAfterSeconds: null,
    });
    await fixture.whenStable();
    expect(root.querySelector('[data-testid="team-command"]')).toBeNull();
    expect(text(root.querySelector('tc-state-block'))).toContain('Не удалось загрузить статус');
  });
});
