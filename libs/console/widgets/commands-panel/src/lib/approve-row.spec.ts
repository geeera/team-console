import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationInitStatus, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ANSWERED_ITEMS_STORAGE, AnsweredItems } from '@console/entities/project';
import { PushStore } from '@console/entities/push';
import { QuestionsApi, type QuestionItem } from '@console/entities/question';
import { TeamStatusStore } from '@console/entities/team-run';
import { BatchApproveOpener, type BatchApproved } from '@console/features/batch-approve';
import { RequestChange } from '@console/features/request-change';
import { SnoozeCommands } from '@console/features/snooze';
import { SprintControls } from '@console/features/sprint-controls';
import { TeamCommands } from '@console/features/team-commands';
import { NetworkStatus } from '@console/shared/api';
import { provideConsoleI18n } from '@console/shared/i18n';
import type { TeamStatusDto } from '@shared/contracts';
import { CommandsPanel, type CommandsProject } from './commands-panel';

const PROJECT: CommandsProject = { slug: 'tc', name: 'Team Console', repo: 'geeera/team-console' };

function item(number: number, overrides: Partial<QuestionItem> = {}): QuestionItem {
  return {
    project: { slug: 'tc', name: 'Team Console' },
    section: 'question',
    number,
    title: `Question ${number}`,
    url: null,
    ask: '/approve (recommended) · /reject why',
    body: null,
    authorTrusted: true,
    allowedCommands: ['approve', 'reject'],
    category: 'scope',
    recommendation: 'approve',
    context: null,
    ...overrides,
  };
}

function status(overrides: Partial<TeamStatusDto> = {}): TeamStatusDto {
  return {
    state: 'running',
    pausedAt: null,
    runLogUrl: null,
    ownerConnected: true,
    environment: 'stage',
    snooze: { snoozed: false },
    checkedAt: new Date().toISOString(),
    sprint: null,
    progress: null,
    calendar: null,
    pendingRequests: 0,
    pauseHolds: true,
    pauseLiftsAtNextRun: false,
    slots: [],
    ...overrides,
  };
}

@Component({
  imports: [CommandsPanel],
  template: `<tc-commands-panel [project]="project" />`,
})
class Host {
  readonly project = PROJECT;
}

describe('CommandsPanel — Approve team recommendations (#246)', () => {
  let questions: ReturnType<typeof vi.fn>;
  let opener: { isOpen: ReturnType<typeof signal<boolean>>; open: ReturnType<typeof vi.fn> };
  let online: ReturnType<typeof signal<boolean>>;

  async function render(
    read: () => Promise<QuestionItem[]>,
    initial: TeamStatusDto = status(),
    closedWith: BatchApproved | null = { approved: [], hasChanged: false },
  ) {
    questions = vi.fn(read);
    opener = { isOpen: signal(false), open: vi.fn(async () => closedWith) };
    online = signal(true);
    const stub = vi.fn(async () => null);
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideConsoleI18n(),
        { provide: QuestionsApi, useValue: { projectQuestions: questions } },
        { provide: BatchApproveOpener, useValue: opener },
        { provide: ANSWERED_ITEMS_STORAGE, useValue: { read: () => null, write: () => undefined } },
        { provide: TeamCommands, useValue: { pause: stub, resume: stub, run: stub } },
        { provide: SprintControls, useValue: { moveDemo: stub, startNext: stub } },
        { provide: RequestChange, useValue: { ask: stub } },
        { provide: NetworkStatus, useValue: { online } },
        { provide: PushStore, useValue: { view: signal('on'), refresh: async () => undefined } },
        { provide: SnoozeCommands, useValue: { snooze: stub, turnBackOn: stub, untilText: () => '' } },
      ],
    }).compileComponents();
    await TestBed.inject(ApplicationInitStatus).donePromise;
    const store = TestBed.inject(TeamStatusStore);
    store.slug.set('tc');
    store.status.set(initial);
    store.phase.set('ready');
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
    return { fixture, root: fixture.nativeElement as HTMLElement };
  }

  const text = (element: Element | null | undefined): string =>
    element?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

  it('with safe items: the count, what is left out, and Review opens the batch over this project', async () => {
    const waiting = [item(3), item(4, { category: 'money' }), item(5)];
    const { root } = await render(async () => waiting);
    expect(questions).toHaveBeenCalledWith({ slug: 'tc', name: 'Team Console' });
    const row = root.querySelector('[data-testid="approve-row"]');
    expect(text(row?.querySelector('.cmd__title'))).toBe('Одобрить советы команды');
    expect(text(row?.querySelector('[data-testid="approve-hint"]'))).toBe(
      '2 можно одобрить разом, 1 — только по одному.',
    );
    const button = row?.querySelector('[data-testid="approve-command"]') as HTMLButtonElement;
    expect(text(button)).toBe('Посмотреть');
    expect(button.getAttribute('aria-label')).toBe('Одобрить советы команды: 2');
    expect(button.getAttribute('aria-disabled')).toBeNull();
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(root.querySelector(`#${button.getAttribute('aria-describedby')}`)).toBe(
      row?.querySelector('[data-testid="approve-hint"]'),
    );
    button.click();
    expect(opener.open).toHaveBeenCalledWith(waiting);
  });

  it('with nothing safe to batch: says so and has no button', async () => {
    const { root } = await render(async () => [item(4, { category: 'money' })]);
    const row = root.querySelector('[data-testid="approve-row"]');
    expect(text(row?.querySelector('[data-testid="approve-line"]'))).toBe('Сейчас нечего одобрять пакетом');
    expect(row?.querySelector('button')).toBeNull();
  });

  it('without the owner connection: the button stays focusable, says why and opens nothing', async () => {
    const { root } = await render(async () => [item(3)], status({ ownerConnected: false }));
    const button = root.querySelector('[data-testid="approve-command"]') as HTMLButtonElement;
    expect(button.getAttribute('aria-disabled')).toBe('true');
    const why = root.querySelector(`#${button.getAttribute('aria-describedby')?.split(' ')[0]}`);
    expect(text(why)).toBe('Сначала подключите GitHub');
    button.click();
    expect(opener.open).not.toHaveBeenCalled();
  });

  it('leaves out what this device already answered, as Needs you does', async () => {
    const { fixture, root } = await render(async () => [item(3), item(5)]);
    TestBed.inject(AnsweredItems).record({
      slug: 'tc',
      number: 3,
      command: 'approve',
      url: 'https://github.com/geeera/team-console/issues/3#c',
      answeredAt: new Date().toISOString(),
    });
    await fixture.whenStable();
    expect(text(root.querySelector('[data-testid="approve-hint"]'))).toBe('1 можно одобрить разом.');
  });

  it('hides the row while the questions are read and says so when they cannot be', async () => {
    let fail: (error: Error) => void = () => undefined;
    const { fixture, root } = await render(
      () =>
        new Promise<QuestionItem[]>((_, reject) => {
          fail = reject;
        }),
    );
    expect(root.querySelector('[data-testid="approve-row"]')).toBeNull();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fail(new Error('offline'));
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
    expect(text(root.querySelector('[data-testid="approve-line"]'))).toBe(
      'Не удалось прочитать вопросы проекта. Обновите статус выше.',
    );
    expect(root.querySelector('[data-testid="approve-command"]')).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('after a batch: the result note says how many, and changed items read the list again', async () => {
    const { fixture, root } = await render(async () => [item(3), item(5)], status(), {
      approved: [item(3)],
      hasChanged: true,
    });
    (root.querySelector('[data-testid="approve-command"]') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
    expect(text(root.querySelector('.cp-result'))).toContain('Одобрено: 1. Записано от вашего имени.');
    expect(questions).toHaveBeenCalledTimes(2);
  });
});
