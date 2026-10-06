import { provideHttpClient } from '@angular/common/http';
import { HttpErrorResponse } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationInitStatus } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TeamStatusStore, commandFailureOf, type CommandResult } from '@console/entities/team-run';
import { provideConsoleI18n } from '@console/shared/i18n';
import { ConfirmFailure, Sheet, type ConfirmOptions } from '@console/shared/ui';
import { PROBLEM_TYPE_PREFIX, type TeamStatusDto } from '@shared/contracts';
import { SprintControls } from './sprint-controls';
import { SprintControlsClient } from './sprint-controls.client';

const TARGET = { slug: 'tc', name: 'Team Console' };

function status(overrides: Partial<TeamStatusDto> = {}): TeamStatusDto {
  return {
    state: 'running',
    pausedAt: null,
    runLogUrl: null,
    ownerConnected: true,
    environment: 'local',
    checkedAt: '2026-10-05T09:00:00.000Z',
    slots: [],
    sprint: {
      number: 4,
      title: 'Sprint 04',
      due: '2026-10-14',
      freeze: { from: '2026-10-12', to: '2026-10-14' },
      next: null,
    },
    progress: { done: 1, total: 3 },
    calendar: { today: '2026-10-05', freezeDays: 2, nextTitle: 'Sprint 05' },
    ...overrides,
  };
}

function refused(slug: string, code: number, extra: Record<string, unknown> = {}): CommandResult<never> {
  const error = new HttpErrorResponse({
    status: code,
    headers: undefined,
    error: { type: `${PROBLEM_TYPE_PREFIX}${slug}`, title: 'refused', status: code, ...extra },
  });
  return { ok: false, failure: commandFailureOf(error) };
}

describe('SprintControls', () => {
  let controls: SprintControls;
  /** Answers of the client, in order; what it was sent. */
  let answers: CommandResult<unknown>[];
  let sent: unknown[];
  let shown: ConfirmOptions[];
  /** What each press sends from the field; the dialog would stay open on a ConfirmFailure. */
  let presses: string[];
  let refusals: { message: string; refill: string | undefined }[];

  const answer = async (_slug: string, body: unknown): Promise<CommandResult<unknown>> => {
    sent.push(body);
    const next = answers.shift();
    if (next === undefined) {
      throw new Error('no answer scripted');
    }
    return next;
  };

  async function setup(initial: TeamStatusDto | null = status()): Promise<void> {
    sent = [];
    shown = [];
    refusals = [];
    const sheet = {
      confirm: vi.fn(async (options: ConfirmOptions) => {
        shown.push(options);
        for (const value of presses) {
          try {
            await options.action?.(value);
            return true;
          } catch (error: unknown) {
            if (!(error instanceof ConfirmFailure)) {
              throw error;
            }
            refusals.push({ message: error.message, refill: error.refill });
          }
        }
        return false;
      }),
    };
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideConsoleI18n(),
        { provide: Sheet, useValue: sheet },
        { provide: SprintControlsClient, useValue: { moveDemo: answer, startNext: answer } },
      ],
    });
    await TestBed.inject(ApplicationInitStatus).donePromise;
    const store = TestBed.inject(TeamStatusStore);
    vi.spyOn(store, 'refresh').mockResolvedValue(undefined);
    if (initial !== null) {
      store.slug.set('tc');
      store.status.set(initial);
      store.phase.set('ready');
    }
    controls = TestBed.inject(SprintControls);
    controls.now = () => Date.parse('2026-10-05T09:00:00.000Z');
  }

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('moves the demo: one dialog with the date, the freeze it means, and the result', async () => {
    presses = ['2026-10-16'];
    await setup();
    answers = [
      {
        ok: true,
        value: {
          sprint: { number: 4, title: 'Sprint 04', due: '2026-10-16' },
          freeze: { from: '2026-10-14', to: '2026-10-16' },
          freezeStartsNow: false,
        },
      },
    ];
    const outcome = await controls.moveDemo(TARGET);
    expect(sent).toEqual([{ due: '2026-10-16', expectedDue: '2026-10-14' }]);
    expect(shown).toHaveLength(1);
    expect(shown[0]?.title).toBe('Перенести демо Sprint 04?');
    expect(shown[0]?.input).toMatchObject({ type: 'date', value: '2026-10-14', min: '2026-10-05' });
    expect(outcome).toMatchObject({ tone: 'positive', verb: 'Демо Sprint 04 перенесено на 16 октября' });
  });

  it('checks the date as the Worker will: past, unchanged, after the next demo, freeze now', async () => {
    presses = [];
    await setup(
      status({
        sprint: {
          number: 4,
          title: 'Sprint 04',
          due: '2026-10-14',
          freeze: { from: '2026-10-12', to: '2026-10-14' },
          next: { number: 5, title: 'Sprint 05', due: '2026-10-28' },
        },
      }),
    );
    await controls.moveDemo(TARGET);
    const check = shown[0]?.input?.check;
    if (check === undefined) {
      throw new Error('no check');
    }
    expect(check('2026-10-04').error).toBe(
      'Эта дата уже прошла (по киевскому времени). Выберите сегодня или позже.',
    );
    expect(check('2026-10-14')).toMatchObject({ isBlocked: true, confirmLabel: 'Дата не изменилась' });
    expect(check('2026-10-28').error).toMatch(/^Демо Sprint 05 \(28 октября\)/);
    expect(check('2026-10-06').warning).toBe(
      'Заморозка начнётся сразу: новые задачи в этом спринте брать уже не будут.',
    );
    expect(check('2026-10-20')).toMatchObject({ confirmLabel: 'Перенести на 20 октября' });
    expect(check('2026-10-20').warning).toBeUndefined();
    expect(shown[0]?.input?.max).toBe('2026-10-27');
  });

  it('refills the date with the live one on sprint-changed, and sends the live one as expected next time', async () => {
    presses = ['2026-10-20', '2026-10-21'];
    await setup();
    answers = [
      refused('sprint-changed', 409, { due: '2026-10-15' }),
      {
        ok: true,
        value: {
          sprint: { number: 4, title: 'Sprint 04', due: '2026-10-21' },
          freeze: { from: '2026-10-19', to: '2026-10-21' },
          freezeStartsNow: false,
        },
      },
    ];
    const outcome = await controls.moveDemo(TARGET);
    expect(refusals).toEqual([
      {
        message:
          'Дату демо изменили, пока диалог был открыт (теперь 15 октября). Проверьте и перенесите снова.',
        refill: '2026-10-15',
      },
    ]);
    expect(sent).toEqual([
      { due: '2026-10-20', expectedDue: '2026-10-14' },
      { due: '2026-10-21', expectedDue: '2026-10-15' },
    ]);
    expect(outcome?.tone).toBe('positive');
  });

  it('reads a repeat that finds its own date as "nothing changed"', async () => {
    presses = ['2026-10-16'];
    await setup();
    answers = [refused('sprint-changed', 409, { due: '2026-10-16' })];
    const outcome = await controls.moveDemo(TARGET);
    expect(outcome).toMatchObject({
      tone: 'neutral',
      verb: 'Демо уже назначено на 16 октября. Ничего не изменено.',
    });
  });

  it('starts the next sprint with the default two weeks after the current demo', async () => {
    presses = ['2026-10-28'];
    await setup();
    answers = [
      {
        ok: true,
        value: {
          sprint: { number: 5, title: 'Sprint 05', due: '2026-10-28' },
          becomesCurrentAfter: '2026-10-14',
        },
      },
    ];
    const outcome = await controls.startNext(TARGET);
    expect(shown[0]?.title).toBe('Начать Sprint 05?');
    expect(shown[0]?.input).toMatchObject({ value: '2026-10-28', min: '2026-10-15' });
    expect(shown[0]?.input?.check?.('2026-10-14').error).toBe('Демо Sprint 05 должно быть позже 14 октября.');
    expect(sent).toEqual([{ due: '2026-10-28', expectedCurrent: 'Sprint 04' }]);
    expect(outcome).toMatchObject({ tone: 'positive', verb: 'Sprint 05 создан' });
  });

  it('is not offered when the next sprint exists, and a race answers "nothing changed"', async () => {
    presses = ['2026-10-28'];
    await setup();
    answers = [refused('sprint-exists', 409, { nextTitle: 'Sprint 05', nextDue: '2026-10-27' })];
    const outcome = await controls.startNext(TARGET);
    expect(outcome).toMatchObject({
      tone: 'neutral',
      verb: 'Sprint 05 уже создан (демо 27 октября). Ничего не изменено.',
    });
  });

  it('says why without a dialog when the owner is not connected', async () => {
    presses = [];
    await setup(status({ ownerConnected: false }));
    const outcome = await controls.moveDemo(TARGET);
    expect(shown).toEqual([]);
    expect(outcome?.tone).toBe('warning');
  });
});
