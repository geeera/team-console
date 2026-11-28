import { ApplicationInitStatus, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  idleOrchestrationFixture,
  OrchestrationApi,
  runningOrchestrationFixture,
  type OrchestrationFailureKind,
  type OrchestrationResult,
} from '@console/entities/orchestration';
import { provideConsoleI18n } from '@console/shared/i18n';
import { ConfirmFailure, Sheet, type ConfirmOptions } from '@console/shared/ui';
import type { OrchestrationDto, RunnerAvailability } from '@shared/contracts';
import { OrchestrationControls } from './orchestration-controls';

type Answer = OrchestrationResult<OrchestrationDto>;

const ok = (value: OrchestrationDto): Answer => ({ ok: true, value });
const refused = (kind: OrchestrationFailureKind, slug: string | null = null): Answer => ({
  ok: false,
  failure: { kind, slug },
});

@Component({
  imports: [OrchestrationControls],
  template: `<tc-orchestration-controls
    [slug]="'team-console'"
    [availability]="availability()"
    (changed)="changes.push($event)"
  />`,
})
class Host {
  readonly availability = signal<RunnerAvailability | null>('ready');
  readonly changes: OrchestrationDto[] = [];
}

describe('OrchestrationControls (#1042)', () => {
  async function setup(first: Answer, options: { cancel?: boolean } = {}) {
    const reads: Answer[] = [first];
    const starts: Answer[] = [];
    const stops: Answer[] = [];
    const confirms: ConfirmOptions[] = [];
    const failures: string[] = [];
    const api = {
      get: vi.fn(async () => reads.shift() ?? first),
      start: vi.fn(async () => starts.shift() ?? ok(runningOrchestrationFixture())),
      stop: vi.fn(async () => stops.shift() ?? ok(idleOrchestrationFixture())),
    };
    // Like the real dialog: a ConfirmFailure keeps it open with the message, then the owner cancels.
    const sheet = {
      confirm: vi.fn(async (confirm: ConfirmOptions) => {
        confirms.push(confirm);
        if (options.cancel === true) {
          return false;
        }
        try {
          await confirm.action?.('');
          return true;
        } catch (error: unknown) {
          if (!(error instanceof ConfirmFailure)) {
            throw error;
          }
          failures.push(error.message);
          return false;
        }
      }),
    };
    TestBed.configureTestingModule({
      imports: [Host],
      providers: [
        provideConsoleI18n(),
        { provide: OrchestrationApi, useValue: api },
        { provide: Sheet, useValue: sheet },
      ],
    });
    await TestBed.inject(ApplicationInitStatus).donePromise;
    const fixture = TestBed.createComponent(Host);
    const root = fixture.nativeElement as HTMLElement;
    const settle = async (): Promise<void> => {
      for (let index = 0; index < 5; index += 1) {
        await new Promise((done) => setTimeout(done, 0));
      }
      await fixture.whenStable();
    };
    await settle();
    const button = (): HTMLButtonElement =>
      root.querySelector('[data-testid="orchestration-action"]') as HTMLButtonElement;
    const text = (testId: string): string =>
      root.querySelector(`[data-testid="${testId}"]`)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    const press = async (): Promise<void> => {
      button().click();
      await settle();
    };
    return {
      fixture,
      root,
      api,
      sheet,
      confirms,
      failures,
      starts,
      stops,
      reads,
      button,
      text,
      press,
      settle,
    };
  }

  it('offers «Запустить команду» with no run; Start queues a step, says so and tells the host', async () => {
    const view = await setup(ok(idleOrchestrationFixture()));
    expect(view.button().dataset['action']).toBe('start');
    expect(view.button().textContent).toContain('Запустить команду');
    expect(view.text('orchestration-state')).toBe(
      'Команда сейчас не работает. После запуска она по шагам берёт одобренные задачи.',
    );

    await view.press();
    expect(view.api.start).toHaveBeenCalledWith('team-console');
    expect(view.text('orchestration-outcome')).toBe('Команда запущена: первый шаг в очереди.');
    expect(view.fixture.componentInstance.changes).toEqual([runningOrchestrationFixture()]);
    // The same button, now Stop: focus never falls off a removed element.
    expect(view.button().dataset['action']).toBe('stop');
    expect(view.text('orchestration-state')).toBe('Команда работает: шаг 1 из 20.');
  });

  it('says the step waits when the runner is away', async () => {
    const view = await setup(ok(idleOrchestrationFixture()));
    view.fixture.componentInstance.availability.set('offline');
    await view.settle();
    await view.press();
    expect(view.text('orchestration-outcome')).toBe(
      'Команда запущена: первый шаг начнётся, когда раннер вернётся.',
    );
  });

  it.each<[string, Answer, string, string]>([
    [
      'orchestration-active',
      refused('active', 'orchestration-active'),
      'neutral',
      'Команда уже работает. Чтобы начать заново, сначала остановите её.',
    ],
    [
      'run-paused',
      refused('paused', 'run-paused'),
      'danger',
      'Разработка на паузе. Снимите паузу, затем запустите команду.',
    ],
    [
      'job-exists',
      refused('exists', 'job-exists'),
      'danger',
      'Сейчас выполняется другая задача оркестратора, например слот, запущенный кнопкой «Запустить». Дождитесь её окончания.',
    ],
    [
      'no network',
      refused('offline'),
      'danger',
      'Нет сети. Ничего не изменилось — попробуйте, когда связь вернётся.',
    ],
    ['another slug', refused('error', 'something-new'), 'danger', 'Что-то пошло не так. Попробуйте ещё раз.'],
  ])('words a refused Start (%s) by its slug', async (_name, answer, tone, line) => {
    const view = await setup(ok(idleOrchestrationFixture()));
    view.starts.push(answer);
    await view.press();
    const outcome = view.root.querySelector('[data-testid="orchestration-outcome"] span') as HTMLElement;
    expect(outcome.dataset['tone']).toBe(tone);
    expect(outcome.textContent?.trim()).toBe(line);
    expect(view.fixture.componentInstance.changes).toEqual([]);
  });

  it('reads the run again after orchestration-active, so Stop shows', async () => {
    const view = await setup(ok(idleOrchestrationFixture()));
    view.starts.push(refused('active', 'orchestration-active'));
    view.reads.push(ok(runningOrchestrationFixture()));
    await view.press();
    expect(view.api.get).toHaveBeenCalledTimes(2);
    expect(view.button().dataset['action']).toBe('stop');
  });

  it('asks before Stop with a danger confirmation, then stops, says so and tells the host', async () => {
    const view = await setup(ok(runningOrchestrationFixture()));
    expect(view.button().dataset['action']).toBe('stop');
    expect(view.button().textContent).toContain('Остановить');

    await view.press();
    expect(view.confirms[0]).toMatchObject({
      title: 'Остановить команду?',
      tone: 'danger',
      confirmLabel: 'Остановить',
      cancelLabel: 'Не останавливать',
    });
    expect(view.api.stop).toHaveBeenCalledWith('team-console');
    expect(view.text('orchestration-outcome')).toBe('Команда остановлена, её задачи отменены.');
    expect(view.fixture.componentInstance.changes).toEqual([idleOrchestrationFixture()]);
    expect(view.button().dataset['action']).toBe('start');
  });

  it('stops nothing when the owner backs out', async () => {
    const view = await setup(ok(runningOrchestrationFixture()), { cancel: true });
    await view.press();
    expect(view.api.stop).not.toHaveBeenCalled();
    expect(view.text('orchestration-outcome')).toBe('');
    expect(view.button().dataset['action']).toBe('stop');
  });

  it('keeps the dialog with the reason on a refused Stop', async () => {
    const view = await setup(ok(runningOrchestrationFixture()));
    view.stops.push(refused('rate-limited', 'rate-limited'));
    await view.press();
    expect(view.failures).toEqual(['Слишком много запросов. Подождите минуту и попробуйте снова.']);
    expect(view.text('orchestration-outcome')).toBe('');
  });

  it('closes on orchestration-idle with a neutral line and the run read again', async () => {
    const view = await setup(ok(runningOrchestrationFixture()));
    view.stops.push(refused('idle', 'orchestration-idle'));
    view.reads.push(ok(idleOrchestrationFixture()));
    await view.press();
    expect(view.failures).toEqual([]);
    expect(view.text('orchestration-outcome')).toBe('Команда уже остановлена — останавливать нечего.');
    expect(view.button().dataset['action']).toBe('start');
  });

  it('holds Start with a visible reason when no runner serves the project, and a press does nothing', async () => {
    const view = await setup(ok(idleOrchestrationFixture()));
    view.fixture.componentInstance.availability.set('none');
    await view.settle();
    expect(view.button().getAttribute('aria-disabled')).toBe('true');
    const reason = document.getElementById(view.button().getAttribute('aria-describedby') ?? '');
    expect(reason?.textContent?.trim()).toBe(
      'Запустить команду пока нельзя: ни один раннер не обслуживает этот проект.',
    );
    await view.press();
    expect(view.api.start).not.toHaveBeenCalled();
  });

  it('says the state is unknown after a failed first read, with the reason', async () => {
    const view = await setup(refused('offline'));
    expect(view.text('orchestration-state')).toBe('Не удалось узнать, работает ли команда.');
    expect(view.text('orchestration-outcome')).toBe(
      'Нет сети. Ничего не изменилось — попробуйте, когда связь вернётся.',
    );
    expect(view.button().dataset['action']).toBe('start');
  });
});
