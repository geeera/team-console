import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationInitStatus } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TeamStatusStore, commandFailureOf, type CommandOutcome } from '@console/entities/team-run';
import { provideConsoleI18n } from '@console/shared/i18n';
import { ConfirmFailure, Sheet, type ConfirmOptions } from '@console/shared/ui';
import { PROBLEM_TYPE_PREFIX, type TeamStatusDto } from '@shared/contracts';
import { TeamCommands } from './team-commands';
import { runUrl, teamCommandUrl } from './team-commands.client';

const TARGET = { slug: 'tc', name: 'Team Console' };
const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const STATUS_URL = '/api/v1/projects/tc/team/status';

function status(overrides: Partial<TeamStatusDto> = {}): TeamStatusDto {
  const secrets = (slot: string) => ({ token: `SLOT_TOKEN_TC_${slot}`, routine: `SLOT_ROUTINE_TC_${slot}` });
  return {
    state: 'running',
    pausedAt: null,
    runLogUrl: 'https://github.com/geeera/team-console/issues/22',
    ownerConnected: true,
    environment: 'production',
    snooze: { snoozed: false },
    checkedAt: '2026-10-01T12:00:00.000Z',
    sprint: null,
    progress: null,
    calendar: null,
    pendingRequests: 0,
    slots: (['pm', 'dev', 'qa'] as const).map((slot) => ({
      slot,
      setup: 'present',
      secrets: secrets(slot.toUpperCase()),
      lastRun: null,
      lock: null,
    })),
    ...overrides,
  };
}

function problem(slug: string, code: number, extra: Record<string, unknown> = {}): object {
  return { type: `${PROBLEM_TYPE_PREFIX}${slug}`, title: 'refused', status: code, ...extra };
}

describe('TeamCommands', () => {
  let commands: TeamCommands;
  let store: TeamStatusStore;
  let http: HttpTestingController;
  let shown: ConfirmOptions[];
  /** What the next confirmation's action threw (the dialog would show it and stay open). */
  let refusals: string[];
  let input = '';

  async function setup(initial: TeamStatusDto = status()): Promise<void> {
    shown = [];
    refusals = [];
    const sheet = {
      confirm: vi.fn(async (options: ConfirmOptions) => {
        shown.push(options);
        try {
          await options.action?.(input);
          return true;
        } catch (error: unknown) {
          if (!(error instanceof ConfirmFailure)) {
            throw error;
          }
          refusals.push(error.message);
          return false;
        }
      }),
    };
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideConsoleI18n(),
        { provide: Sheet, useValue: sheet },
      ],
    });
    await TestBed.inject(ApplicationInitStatus).donePromise;
    http = TestBed.inject(HttpTestingController);
    store = TestBed.inject(TeamStatusStore);
    commands = TestBed.inject(TeamCommands);
    commands.now = () => NOW;
    const loaded = store.load('tc');
    http.expectOne(STATUS_URL).flush(initial);
    await loaded;
  }

  /** Answers the command request, then the status read the command triggers. */
  async function answer(
    pending: Promise<CommandOutcome | null>,
    url: string,
    body: unknown,
    code = 200,
    headers: Record<string, string> = {},
  ): Promise<{ outcome: CommandOutcome | null; sent: unknown }> {
    await Promise.resolve();
    const request = http.expectOne(url);
    const sent = request.request.body;
    request.flush(body, { status: code, statusText: 'x', headers });
    const outcome = await pending;
    http.match(STATUS_URL).forEach((read) => read.flush(store.status()));
    return { outcome, sent };
  }

  afterEach(() => {
    input = '';
  });

  it('pause: one confirmation with the points and the optional reason; done is a moss note', async () => {
    await setup();
    input = 'отпуск';
    const { outcome, sent } = await answer(
      commands.pause(TARGET),
      teamCommandUrl('tc', 'pause'),
      {
        state: 'paused-by-owner',
        runLogUrl: 'https://github.com/geeera/team-console/issues/22',
        commentUrl: 'https://github.com/x',
        replayed: false,
      },
      201,
    );
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({
      title: 'Приостановить разработку в Team Console?',
      items: [
        'Идущий сейчас прогон доделает свою работу.',
        'Следующие прогоны по расписанию будут запускаться и сразу завершаться — так же, как после паузы из чата команды.',
        'Вопросы к вам останутся в «Ждут вас».',
      ],
      input: { label: 'Причина (необязательно)', maxLength: 300 },
      confirmLabel: 'Приостановить',
      retryLabel: 'Повторить',
    });
    expect(sent).toEqual({ reason: 'отпуск' });
    expect(outcome).toMatchObject({
      tone: 'positive',
      verb: 'Разработка в Team Console на паузе',
      runLogUrl: 'https://github.com/geeera/team-console/issues/22',
    });
    expect(store.status()?.state).toBe('paused-by-owner');
  });

  it('pause of a paused team changes nothing: a grey note, no error', async () => {
    await setup();
    const { outcome, sent } = await answer(
      commands.pause(TARGET),
      teamCommandUrl('tc', 'pause'),
      problem('team-already-paused', 409, { pausedAt: '2026-10-01T10:52:00Z', state: 'paused-by-owner' }),
      409,
    );
    expect(sent).toEqual({});
    expect(outcome?.tone).toBe('neutral');
    expect(outcome?.verb).toMatch(/^Team Console уже на паузе с \d\d:\d\d\. Ничего не изменено\.$/);
  });

  it('pause without the GitHub connection keeps the dialog open with what to do', async () => {
    await setup();
    const { outcome } = await answer(
      commands.pause(TARGET),
      teamCommandUrl('tc', 'pause'),
      problem('github-owner-not-connected', 403),
      403,
    );
    expect(outcome).toBeNull();
    expect(refusals).toEqual([
      'Сначала подключите GitHub в настройках: эти команды пишутся от вашего имени. Ничего не изменено.',
    ]);
  });

  it('pause where the team opened the run log is refused with the way that works (#141)', async () => {
    await setup();
    const { outcome } = await answer(
      commands.pause(TARGET),
      teamCommandUrl('tc', 'pause'),
      problem('pause-unreliable', 409),
      409,
    );
    expect(outcome).toBeNull();
    expect(refusals).toEqual([
      'Пауза из консоли для этого проекта пока ненадёжна: журнал запусков завела команда, и следующий прогон может снять паузу. Поставьте паузу из чата команды (навык pause). Ничего не изменено.',
    ]);
    expect(store.status()?.state).toBe('running');
  });

  it('resume after the team paused itself warns to check the run log first', async () => {
    await setup(status({ state: 'paused-by-team' }));
    const { outcome } = await answer(
      commands.resume(TARGET),
      teamCommandUrl('tc', 'resume'),
      {
        state: 'running',
        runLogUrl: 'https://github.com/geeera/team-console/issues/22',
        commentUrl: 'https://github.com/x',
        replayed: false,
      },
      201,
    );
    expect(shown[0]?.warning).toMatch(/^Команда остановилась сама/);
    expect(outcome?.verb).toBe('Разработка в Team Console возобновлена');
    expect(store.status()?.state).toBe('running');
  });

  it('run now: names the slot, then locks the row as requested', async () => {
    await setup();
    const { outcome, sent } = await answer(
      commands.run(TARGET, 'dev'),
      runUrl('tc'),
      {
        slot: 'dev',
        requestedAt: '2026-10-01T12:00:00.000Z',
        lockedUntil: '2026-10-01T12:15:00.000Z',
        runLogUrl: 'https://github.com/geeera/team-console/issues/22',
      },
      202,
    );
    expect(shown[0]).toMatchObject({
      title: 'Запустить разработку сейчас?',
      message: 'Команда возьмёт до двух задач спринта.',
      confirmLabel: 'Запустить',
    });
    expect(sent).toEqual({ slot: 'dev' });
    expect(outcome).toMatchObject({
      tone: 'positive',
      verb: 'Запрошено: разработка',
      detail: 'Прогон появится в журнале через пару минут.',
    });
    expect(store.status()?.slots[1]?.lock).toEqual({
      kind: 'requested',
      since: '2026-10-01T12:00:00.000Z',
      until: '2026-10-01T12:15:00.000Z',
    });
  });

  it('a run in progress is a grey note and locks the row for its window', async () => {
    await setup();
    const { outcome } = await answer(
      commands.run(TARGET, 'qa'),
      runUrl('tc'),
      problem('run-in-progress', 409, {
        runId: 'r1',
        since: '2026-10-01T11:00:00Z',
        until: '2026-10-01T14:00:00Z',
      }),
      409,
    );
    expect(outcome?.tone).toBe('neutral');
    expect(outcome?.verb).toMatch(/^Проверка \(QA\): прогон уже идёт с \d\d:\d\d\./);
    expect(store.status()?.slots[2]?.lock).toMatchObject({ kind: 'started', runId: 'r1' });
  });

  it('no answer is an ochre note: unknown whether it started, retry opens later', async () => {
    await setup();
    const { outcome } = await answer(
      commands.run(TARGET, 'pm'),
      runUrl('tc'),
      problem('routine-unknown', 504, { until: '2026-10-01T12:15:00.000Z' }),
      504,
    );
    expect(outcome?.tone).toBe('warning');
    expect(outcome?.verb).toMatch(/^Сервис запусков не ответил, поэтому неизвестно/);
    expect(store.status()?.slots[0]?.lock).toMatchObject({
      kind: 'unknown',
      until: '2026-10-01T12:15:00.000Z',
    });
  });

  it.each([
    [
      'routine-rate-limited',
      429,
      {},
      { 'Retry-After': '1200' },
      /^Лимит запусков исчерпан: не больше 30 в час для этой рутины или 100 в час на все проекты аккаунта\. Можно снова в \d\d:\d\d\. Ничего не запущено\.$/,
    ],
    [
      'routine-paused',
      409,
      {},
      {},
      /^Рутина «Разработка» выключена в Claude Code, поэтому ничего не запущено\. Включите её на claude\.ai\/code\/routines и запустите снова\.$/,
    ],
    ['routine-not-configured', 409, { step: 'token' }, {}, /Сохраните SLOT_TOKEN_TC_DEV заново/],
    ['routine-not-configured', 409, { step: 'routine' }, {}, /Проверьте SLOT_ROUTINE_TC_DEV/],
    ['routine-unavailable', 502, {}, {}, /^Сервис запусков не ответил\. Ничего не запущено\.$/],
    ['run-paused', 409, {}, {}, /^Разработка на паузе/],
  ] as const)(
    'a refusal %s keeps the dialog open with its reason',
    async (slug, code, extra, headers, message) => {
      await setup();
      const { outcome } = await answer(
        commands.run(TARGET, 'dev'),
        runUrl('tc'),
        problem(slug, code, extra),
        code,
        headers,
      );
      expect(outcome).toBeNull();
      expect(refusals).toHaveLength(1);
      expect(refusals[0]).toMatch(message);
    },
  );
});

describe('commandFailureOf', () => {
  it('is offline for status 0 and unknown for anything that is not an HTTP error', () => {
    expect(commandFailureOf(null).kind).toBe('unknown');
  });
});
