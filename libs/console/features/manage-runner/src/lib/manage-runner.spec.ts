import { TestBed } from '@angular/core/testing';
import { RunnersApi, runnerFixture, type RunnerResult } from '@console/entities/runner';
import { provideConsoleI18n } from '@console/shared/i18n';
import { ConfirmFailure, DIALOG_DATA, DialogRef, Sheet, type ConfirmOptions } from '@console/shared/ui';
import { OWNER_ACCOUNT_ID, type RunnerDto } from '@shared/contracts';
import { of } from 'rxjs';
import { ManageRunner } from './manage-runner';
import { RunnerProjectsDialog, type RunnerProjectsData } from './runner-projects-dialog';

const REVOKED = runnerFixture({ revokedAt: '2026-11-11T10:00:00.000Z', online: false });

describe('ManageRunner.revoke (#464)', () => {
  /** A Sheet whose confirm runs the action like the real dialog: a ConfirmFailure keeps it open, then Cancel. */
  function setup(answers: RunnerResult<RunnerDto>[]) {
    const options: ConfirmOptions[] = [];
    const failures: string[] = [];
    const sheet = {
      confirm: vi.fn(async (confirm: ConfirmOptions) => {
        options.push(confirm);
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
    const revoke = vi.fn(async () => answers.shift() ?? { ok: true as const, value: REVOKED });
    TestBed.configureTestingModule({
      providers: [
        provideConsoleI18n(),
        { provide: Sheet, useValue: sheet },
        { provide: RunnersApi, useValue: { revoke } },
      ],
    });
    return { manage: TestBed.inject(ManageRunner), options, failures, revoke };
  }

  it('asks with a danger confirmation naming the runner and what revoking does, then revokes', async () => {
    const { manage, options, revoke } = setup([{ ok: true, value: REVOKED }]);
    const outcome = await manage.revoke({ accountId: OWNER_ACCOUNT_ID, runner: runnerFixture() });
    expect(outcome).toEqual({ kind: 'revoked', runner: REVOKED });
    expect(revoke).toHaveBeenCalledWith(OWNER_ACCOUNT_ID, runnerFixture().id);
    expect(options[0]).toMatchObject({
      title: 'Отозвать раннер «Mac»?',
      tone: 'danger',
      confirmLabel: 'Отозвать',
      items: [
        'Консоль перестанет принимать ключ этого раннера.',
        'Задания, которые он сейчас выполняет, будут отменены.',
        'Чтобы снова использовать эту машину, подключите её заново с новым кодом.',
      ],
    });
  });

  it('keeps the dialog with the reason on a refusal and reports nothing revoked', async () => {
    const { manage, failures } = setup([{ ok: false, failure: { kind: 'offline', slug: null, field: null } }]);
    expect(await manage.revoke({ accountId: OWNER_ACCOUNT_ID, runner: runnerFixture() })).toEqual({ kind: 'cancelled' });
    expect(failures[0]).toContain('Нет сети');
  });

  it('reports a runner revoked meanwhile, or gone, as a stale list', async () => {
    for (const kind of ['revoked', 'not-found'] as const) {
      TestBed.resetTestingModule();
      const { manage, failures } = setup([{ ok: false, failure: { kind, slug: null, field: null } }]);
      expect(await manage.revoke({ accountId: OWNER_ACCOUNT_ID, runner: runnerFixture() })).toEqual({ kind: 'stale' });
      expect(failures).toHaveLength(1);
    }
  });

  it('does nothing when the owner cancels', async () => {
    const { manage, revoke } = setup([]);
    (TestBed.inject(Sheet).confirm as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    expect(await manage.revoke({ accountId: OWNER_ACCOUNT_ID, runner: runnerFixture() })).toEqual({ kind: 'cancelled' });
    expect(revoke).not.toHaveBeenCalled();
  });
});

// #492: the same confirm-and-act shape as revoke, for a suspect mark and a pending code.
describe('ManageRunner.clearSuspect and withdrawEnrolment', () => {
  const SUSPECT = runnerFixture({ suspect: { at: '2026-11-12T09:00:00.000Z', reason: 'two-pollers' } });
  const CLEARED = runnerFixture({ suspect: null });
  const PENDING = {
    id: 'a1'.repeat(32),
    name: 'Laptop',
    allowedProjects: [],
    createdAt: '2026-11-12T10:00:00.000Z',
    expiresAt: '2026-11-12T10:10:00.000Z',
  };

  function setup(api: Record<string, unknown>) {
    const options: ConfirmOptions[] = [];
    const failures: string[] = [];
    const sheet = {
      confirm: vi.fn(async (confirm: ConfirmOptions) => {
        options.push(confirm);
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
      providers: [provideConsoleI18n(), { provide: Sheet, useValue: sheet }, { provide: RunnersApi, useValue: api }],
    });
    return { manage: TestBed.inject(ManageRunner), options, failures };
  }

  it('asks before clearing a mark, says to revoke for calls that are not the owner’s, then clears', async () => {
    const clearSuspect = vi.fn(async () => ({ ok: true as const, value: CLEARED }));
    const { manage, options } = setup({ clearSuspect });
    expect(await manage.clearSuspect({ accountId: OWNER_ACCOUNT_ID, runner: SUSPECT })).toEqual({
      kind: 'cleared',
      runner: CLEARED,
    });
    expect(clearSuspect).toHaveBeenCalledWith(OWNER_ACCOUNT_ID, SUSPECT.id);
    expect(options[0]?.title).toBe('Снять отметку с раннера «Mac»?');
    expect(options[0]?.items).toContain('Если вызовы были не ваши, отзовите раннер, а не снимайте отметку.');
    expect(options[0]?.tone).toBeUndefined();
  });

  it('reads a mark cleared meanwhile, a revoked runner or a gone one as a stale list', async () => {
    for (const kind of ['not-suspect', 'revoked', 'not-found'] as const) {
      TestBed.resetTestingModule();
      const { manage, failures } = setup({
        clearSuspect: async () => ({ ok: false as const, failure: { kind, slug: null, field: null } }),
      });
      expect(await manage.clearSuspect({ accountId: OWNER_ACCOUNT_ID, runner: SUSPECT })).toEqual({ kind: 'stale' });
      expect(failures).toHaveLength(1);
    }
  });

  it('withdraws a pending code behind a danger confirmation naming it', async () => {
    const withdrawEnrolment = vi.fn(async () => ({ ok: true as const, value: null }));
    const { manage, options } = setup({ withdrawEnrolment });
    expect(await manage.withdrawEnrolment(OWNER_ACCOUNT_ID, PENDING)).toEqual({ kind: 'withdrawn' });
    expect(withdrawEnrolment).toHaveBeenCalledWith(OWNER_ACCOUNT_ID, PENDING.id);
    expect(options[0]).toMatchObject({ title: 'Отозвать код для «Laptop»?', tone: 'danger' });
  });

  it('reads a code used, expired or withdrawn meanwhile as stale, and an offline refusal as nothing done', async () => {
    const gone = setup({
      withdrawEnrolment: async () => ({
        ok: false as const,
        failure: { kind: 'not-found' as const, slug: 'enrolment-not-found', field: null },
      }),
    });
    expect(await gone.manage.withdrawEnrolment(OWNER_ACCOUNT_ID, PENDING)).toEqual({ kind: 'stale' });
    expect(gone.failures[0]).toContain('уже использован, истёк или отозван');

    TestBed.resetTestingModule();
    const offline = setup({
      withdrawEnrolment: async () => ({ ok: false as const, failure: { kind: 'offline' as const, slug: null, field: null } }),
    });
    expect(await offline.manage.withdrawEnrolment(OWNER_ACCOUNT_ID, PENDING)).toEqual({ kind: 'cancelled' });
  });
});

describe('ManageRunner.editProjects', () => {
  it('opens the allow-list dialog and resolves the runner it closed with', async () => {
    const updated = runnerFixture({ allowedProjects: [] });
    const sheet = { open: vi.fn(() => ({ closed: of(updated) })) };
    TestBed.configureTestingModule({
      providers: [provideConsoleI18n(), { provide: Sheet, useValue: sheet }, { provide: RunnersApi, useValue: {} }],
    });
    const projects = [{ slug: 'team-console', displayName: 'Team Console' }];
    const result = await TestBed.inject(ManageRunner).editProjects({
      accountId: OWNER_ACCOUNT_ID,
      runner: runnerFixture(),
      projects,
    });
    expect(result).toEqual(updated);
    expect(sheet.open).toHaveBeenCalledWith(
      RunnerProjectsDialog,
      expect.objectContaining({ title: 'Проекты раннера', data: { accountId: OWNER_ACCOUNT_ID, runner: runnerFixture(), projects } }),
    );
  });
});

describe('RunnerProjectsDialog', () => {
  async function render(
    runner: RunnerDto,
    answer: () => RunnerResult<RunnerDto> = () => ({ ok: true, value: runnerFixture({ allowedProjects: ['storify'] }) }),
  ) {
    const calls: unknown[][] = [];
    const close = vi.fn();
    const ref = { close, disableClose: false };
    TestBed.configureTestingModule({
      providers: [
        provideConsoleI18n(),
        { provide: DialogRef, useValue: ref },
        {
          provide: DIALOG_DATA,
          useValue: {
            accountId: OWNER_ACCOUNT_ID,
            runner,
            projects: [
              { slug: 'team-console', displayName: 'Team Console' },
              { slug: 'storify', displayName: 'Storify' },
            ],
          } satisfies RunnerProjectsData,
        },
        {
          provide: RunnersApi,
          useValue: {
            setAllowedProjects: async (...args: unknown[]) => {
              calls.push(args);
              return answer();
            },
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(RunnerProjectsDialog);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const settle = async (): Promise<void> => {
      await fixture.whenStable();
      await new Promise((resolve) => setTimeout(resolve));
      await fixture.whenStable();
    };
    const tick = async (slug: string): Promise<void> => {
      (root.querySelector(`[data-slug="${slug}"] input`) as HTMLInputElement).click();
      await fixture.whenStable();
    };
    const submit = async (): Promise<void> => {
      (root.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit', { cancelable: true }));
      await settle();
    };
    return { root, tick, submit, calls, close };
  }

  it('opens with the runner’s projects ticked, warns on narrowing and saves the new list', async () => {
    const { root, tick, submit, calls, close } = await render(runnerFixture());
    const boxes = [...root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes.map((box) => box.checked)).toEqual([true, false]);
    await tick('team-console');
    await tick('storify');
    expect(root.querySelector('[data-testid="runner-projects-narrowing"]')?.textContent).toContain(
      'Текущие задания раннера в проектах team-console будут отменены.',
    );
    await submit();
    expect(calls).toEqual([[OWNER_ACCOUNT_ID, runnerFixture().id, ['storify']]]);
    expect(close).toHaveBeenCalledWith(runnerFixture({ allowedProjects: ['storify'] }));
  });

  it('lists a slug the runner holds that is no longer an active project, so it can be removed', async () => {
    const { root } = await render(runnerFixture({ allowedProjects: ['old-project'] }));
    expect(root.querySelector('[data-slug="old-project"] input')).not.toBeNull();
  });

  it('keeps the dialog with the reason when the Worker refuses', async () => {
    const { root, submit, close } = await render(runnerFixture(), () => ({
      ok: false,
      failure: { kind: 'invalid', slug: 'allowed-projects-invalid', field: 'allowedProjects' },
    }));
    await submit();
    expect(close).not.toHaveBeenCalled();
    expect(root.querySelector('[data-testid="runner-projects-error"]')?.textContent).toContain(
      'Среди проектов есть архивный или чужой.',
    );
    expect(root.querySelector('[data-testid="runner-projects-save"]')?.textContent?.trim()).toBe('Повторить');
  });
});
