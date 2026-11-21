import { TestBed } from '@angular/core/testing';
import { RunnersApi, type RunnerFailure, type RunnerResult } from '@console/entities/runner';
import { provideConsoleI18n } from '@console/shared/i18n';
import { DIALOG_DATA, DialogRef, Sheet } from '@console/shared/ui';
import { OWNER_ACCOUNT_ID, type CreateEnrolmentCodeInput, type EnrolmentCodeDto } from '@shared/contracts';
import { of } from 'rxjs';
import { EnrolRunner } from './enrol-runner';
import { EnrolRunnerDialog, type EnrolRunnerData } from './enrol-runner-dialog';

const CODE = `tce_${'Ab-_'.repeat(10)}xyz`;
const ISSUED: EnrolmentCodeDto = {
  code: CODE,
  expiresAt: '2026-11-11T10:10:00.000Z',
  apiUrl: 'https://team-console-dev.example.dev',
  audience: 'team-console:dev',
  name: 'Mac',
  projectScope: 'selected',
  allowedProjects: ['team-console'],
};

describe('EnrolRunnerDialog (#464)', () => {
  async function render(answer: () => RunnerResult<EnrolmentCodeDto> = () => ({ ok: true, value: ISSUED })) {
    const calls: { accountId: string; input: CreateEnrolmentCodeInput }[] = [];
    const close = vi.fn();
    const ref = { close, disableClose: false };
    let release: (() => void) | null = null;
    let held = false;
    TestBed.configureTestingModule({
      providers: [
        provideConsoleI18n(),
        { provide: DialogRef, useValue: ref },
        {
          provide: DIALOG_DATA,
          useValue: {
            accountId: OWNER_ACCOUNT_ID,
            projects: [
              { slug: 'team-console', displayName: 'Team Console' },
              { slug: 'storify', displayName: 'Storify' },
            ],
          } satisfies EnrolRunnerData,
        },
        {
          provide: RunnersApi,
          useValue: {
            createEnrolmentCode: async (accountId: string, input: CreateEnrolmentCodeInput) => {
              calls.push({ accountId, input });
              if (held) {
                await new Promise<void>((resolve) => (release = resolve));
              }
              return answer();
            },
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(EnrolRunnerDialog);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const find = (id: string): HTMLElement | null => root.querySelector(`[data-testid="${id}"]`);
    const settle = async (): Promise<void> => {
      await fixture.whenStable();
      await new Promise((resolve) => setTimeout(resolve));
      await fixture.whenStable();
    };
    const type = async (value: string): Promise<void> => {
      const input = find('enrol-name') as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event('input'));
      await fixture.whenStable();
    };
    const tick = async (slug: string): Promise<void> => {
      (root.querySelector(`[data-slug="${slug}"] input`) as HTMLInputElement).click();
      await fixture.whenStable();
    };
    const pick = async (scope: 'all' | 'selected'): Promise<void> => {
      const radio = find(`runner-scope-${scope}`) as HTMLInputElement;
      radio.checked = true;
      radio.dispatchEvent(new Event('change'));
      await fixture.whenStable();
    };
    const submit = async (): Promise<void> => {
      (root.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit', { cancelable: true }));
      await settle();
    };
    const hold = (): void => {
      held = true;
    };
    const resume = async (): Promise<void> => {
      held = false;
      (release as (() => void) | null)?.();
      await settle();
    };
    return { root, find, type, pick, tick, submit, calls, close, ref, hold, resume };
  }

  it('issues a code for the name and the chosen projects and shows the enrol command once, with its expiry', async () => {
    const { root, find, type, pick, tick, submit, calls } = await render();
    await type('  Mac  ');
    // #775: all projects is preselected; the list appears once the owner picks "only the chosen ones".
    expect(find('runner-scope-all')).not.toBeNull();
    expect((find('runner-scope-all') as HTMLInputElement).checked).toBe(true);
    expect(root.querySelector('[data-slug="team-console"]')).toBeNull();
    await pick('selected');
    await tick('team-console');
    await submit();
    expect(calls).toEqual([
      { accountId: OWNER_ACCOUNT_ID, input: { name: 'Mac', projectScope: 'selected', allowedProjects: ['team-console'] } },
    ]);
    expect(find('enrol-code')).not.toBeNull();
    expect(root.querySelector('form')).toBeNull();
    expect(root.querySelector('[data-testid="enrol-command"] [data-testid="copy-code-text"]')?.textContent).toBe(
      `TC_ENROL_CODE=${CODE} team-console-runner enrol --url https://team-console-dev.example.dev`,
    );
    // #772: the bare code too, for the `--code -` prompt, with its own copy button named for what it copies.
    const codeOnly = find('enrol-code-only');
    expect(codeOnly?.querySelector('[data-testid="copy-code-text"]')?.textContent).toBe(CODE);
    expect(codeOnly?.querySelector('button')?.getAttribute('aria-label')).toBe(
      'Копировать только код подключения раннера',
    );
    expect(root.textContent).toContain('Если команда попросит код (например, с --code -), вставьте только его:');
    expect(root.textContent).toContain('Код показывается только один раз');
    expect(find('enrol-expiry')?.textContent).toMatch(/Код действует до \d{2}:\d{2} \(10 минут\)/);
    expect(root.textContent).toContain('Проекты: team-console');
  });

  it('closes with true from Done, and the code is gone with the dialog', async () => {
    const { find, type, submit, close } = await render();
    await type('Mac');
    await submit();
    find('enrol-done')?.click();
    expect(close).toHaveBeenCalledWith(true);
  });

  // #775: the default scope is every project of the account, sent as `all` with an empty list, and said in plain words.
  it('issues a code for all projects of the account by default and says what that covers', async () => {
    const { find, type, submit, calls } = await render(() => ({ ok: true, value: { ...ISSUED, projectScope: 'all', allowedProjects: [] } }));
    await type('Mac');
    await submit();
    expect(calls).toEqual([{ accountId: OWNER_ACCOUNT_ID, input: { name: 'Mac', projectScope: 'all', allowedProjects: [] } }]);
    expect(find('enrol-scope')?.textContent).toContain('Проекты: все проекты аккаунта, включая те, что появятся позже.');
  });

  it('refuses an empty name and sends nothing', async () => {
    const { root, type, submit, calls } = await render();
    await type('   ');
    await submit();
    expect(calls).toEqual([]);
    expect(root.textContent).toContain('Введите название раннера');
    expect(root.querySelector('[data-testid="enrol-name"]')?.getAttribute('aria-invalid')).toBe('true');
  });

  it.each([
    [{ kind: 'invalid', slug: 'allowed-projects-invalid', field: 'allowedProjects' }, 'Среди проектов есть архивный или чужой.'],
    [{ kind: 'forbidden', slug: 'account-owner-only', field: null }, 'Это может сделать только владелец аккаунта.'],
    [{ kind: 'offline', slug: null, field: null }, 'Нет сети.'],
    [{ kind: 'rate-limited', slug: 'rate-limited', field: null }, 'Слишком много запросов.'],
  ] satisfies [RunnerFailure, string][])('keeps the form with the reason for %j', async (failure, message) => {
    const { find, type, submit } = await render(() => ({ ok: false, failure }));
    await type('Mac');
    await submit();
    expect(find('enrol-code')).toBeNull();
    expect(find('enrol-error')?.textContent).toContain(message);
    expect(find('enrol-submit')?.textContent?.trim()).toBe('Повторить');
  });

  it('shows no command for an answer it would not offer for a terminal', async () => {
    const { find, type, submit } = await render(() => ({
      ok: true,
      value: { ...ISSUED, apiUrl: 'https://x.dev; curl evil' },
    }));
    await type('Mac');
    await submit();
    expect(find('enrol-code')).toBeNull();
    expect(find('enrol-error')?.textContent).toContain('Что-то пошло не так');
  });

  it('holds the dialog and the controls while the code is being issued', async () => {
    const { find, type, submit, ref, hold, resume, calls } = await render();
    await type('Mac');
    hold();
    void submit();
    await new Promise((resolve) => setTimeout(resolve));
    expect(ref.disableClose).toBe(true);
    expect(find('enrol-submit')?.getAttribute('aria-disabled')).toBe('true');
    expect((find('enrol-name') as HTMLInputElement).readOnly).toBe(true);
    await submit();
    expect(calls).toHaveLength(1);
    await resume();
    expect(ref.disableClose).toBe(false);
    expect(find('enrol-code')).not.toBeNull();
  });
});

describe('EnrolRunner', () => {
  it('opens the dialog for the account and resolves whether a code was issued', async () => {
    const sheet = { open: vi.fn(() => ({ closed: of(true) })) };
    TestBed.configureTestingModule({ providers: [provideConsoleI18n(), { provide: Sheet, useValue: sheet }] });
    const projects = [{ slug: 'team-console', displayName: 'Team Console' }];
    expect(await TestBed.inject(EnrolRunner).open({ accountId: OWNER_ACCOUNT_ID, projects })).toBe(true);
    expect(sheet.open).toHaveBeenCalledWith(
      EnrolRunnerDialog,
      expect.objectContaining({ title: 'Новый раннер', data: { accountId: OWNER_ACCOUNT_ID, projects } }),
    );
    sheet.open.mockReturnValueOnce({ closed: of(undefined) } as never);
    expect(await TestBed.inject(EnrolRunner).open({ accountId: OWNER_ACCOUNT_ID, projects })).toBe(false);
  });
});
