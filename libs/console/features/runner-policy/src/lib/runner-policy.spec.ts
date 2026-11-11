import { TestBed } from '@angular/core/testing';
import {
  RUNNER_FIXTURE_IDS,
  RunnersApi,
  runnerFixture,
  type RunnerPolicyScope,
  type RunnerResult,
} from '@console/entities/runner';
import { provideConsoleI18n } from '@console/shared/i18n';
import { OWNER_ACCOUNT_ID, type RunnerDto, type RunnerPolicy, type RunnerPolicyDto } from '@shared/contracts';
import { RunnerPolicyEditor } from './runner-policy-editor';
import { EMPTY_POLICY_FORM, moveFallback, policyFormOf, policyOfForm } from './runner-policy-form';

const { mac: MAC, vps: VPS, old: OLD } = RUNNER_FIXTURE_IDS;
const RUNNERS: readonly RunnerDto[] = [
  runnerFixture(),
  runnerFixture({ id: VPS, name: 'VPS', isolation: 'container' }),
  runnerFixture({ id: OLD, name: 'Old Mac', revokedAt: '2026-11-01T00:00:00.000Z', online: false }),
];
const ANY: RunnerPolicyDto = { policy: null, effective: { mode: 'any' } };

describe('policyOfForm', () => {
  it('builds each mode the Worker accepts', () => {
    expect(policyOfForm({ ...EMPTY_POLICY_FORM, mode: 'inherit' })).toEqual({ ok: true, policy: null });
    expect(policyOfForm(EMPTY_POLICY_FORM)).toEqual({ ok: true, policy: { mode: 'any' } });
    expect(policyOfForm({ ...EMPTY_POLICY_FORM, mode: 'pinned', pinned: MAC })).toEqual({
      ok: true,
      policy: { mode: 'pinned', runner: MAC },
    });
    expect(
      policyOfForm({ ...EMPTY_POLICY_FORM, mode: 'failover', preferred: MAC, fallback: [VPS, MAC, VPS], offlineAfter: ' 600 ' }),
    ).toEqual({ ok: true, policy: { mode: 'failover', preferred: MAC, fallback: [VPS], offline_after_seconds: 600 } });
  });

  it.each([
    [{ mode: 'pinned' as const }, 'pinned'],
    [{ mode: 'failover' as const, fallback: [VPS] }, 'preferred'],
    [{ mode: 'failover' as const, preferred: MAC, fallback: [MAC] }, 'fallback'],
    [{ mode: 'failover' as const, preferred: MAC, fallback: [VPS], offlineAfter: '29' }, 'offlineAfter'],
    [{ mode: 'failover' as const, preferred: MAC, fallback: [VPS], offlineAfter: '86401' }, 'offlineAfter'],
    [{ mode: 'failover' as const, preferred: MAC, fallback: [VPS], offlineAfter: '1e3' }, 'offlineAfter'],
    [{ mode: 'failover' as const, preferred: MAC, fallback: [VPS], offlineAfter: '' }, 'offlineAfter'],
  ])('names the wrong field of %j', (change, error) => {
    expect(policyOfForm({ ...EMPTY_POLICY_FORM, ...change })).toEqual({ ok: false, error });
  });

  it('opens the form from a stored policy, a project on the default as inherit', () => {
    expect(policyFormOf(null, true).mode).toBe('inherit');
    expect(policyFormOf(null, false).mode).toBe('any');
    expect(
      policyFormOf({ mode: 'failover', preferred: MAC, fallback: [VPS], offline_after_seconds: 120 }, true),
    ).toMatchObject({ mode: 'failover', preferred: MAC, fallback: [VPS], offlineAfter: '120' });
  });

  it('moves a fallback within the list only', () => {
    expect(moveFallback(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(moveFallback(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveFallback(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
    expect(moveFallback(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
  });
});

describe('RunnerPolicyEditor (#464, ADR 0008 decision 12)', () => {
  async function render(
    scope: RunnerPolicyScope,
    {
      read = (): RunnerResult<RunnerPolicyDto> => ({ ok: true, value: ANY }),
      write = (policy: RunnerPolicy | null): RunnerResult<RunnerPolicyDto> => ({
        ok: true,
        value: { policy, effective: policy ?? { mode: 'any' } },
      }),
      runners = RUNNERS,
    } = {},
  ) {
    const writes: { scope: RunnerPolicyScope; policy: RunnerPolicy | null }[] = [];
    let reads = 0;
    let release: (() => void) | null = null;
    let held = false;
    TestBed.configureTestingModule({
      providers: [
        provideConsoleI18n(),
        {
          provide: RunnersApi,
          useValue: {
            policy: async () => {
              reads += 1;
              return read();
            },
            setPolicy: async (target: RunnerPolicyScope, policy: RunnerPolicy | null) => {
              writes.push({ scope: target, policy });
              if (held) {
                await new Promise<void>((resolve) => (release = resolve));
              }
              return write(policy);
            },
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(RunnerPolicyEditor);
    fixture.componentRef.setInput('scope', scope);
    fixture.componentRef.setInput('runners', runners);
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 3; i += 1) {
        await fixture.whenStable();
        await new Promise((resolve) => setTimeout(resolve));
      }
      await fixture.whenStable();
    };
    await settle();
    const root = fixture.nativeElement as HTMLElement;
    const find = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
      root.querySelector<T>(`[data-testid="${id}"]`);
    const choose = async (mode: string): Promise<void> => {
      const radio = find<HTMLInputElement>(`policy-mode-${mode}`) as HTMLInputElement;
      radio.checked = true;
      radio.dispatchEvent(new Event('change'));
      await fixture.whenStable();
    };
    const select = async (id: string, value: string): Promise<void> => {
      const element = find<HTMLSelectElement>(id) as HTMLSelectElement;
      element.value = value;
      element.dispatchEvent(new Event('change'));
      await fixture.whenStable();
    };
    const type = async (id: string, value: string): Promise<void> => {
      const element = find<HTMLInputElement>(id) as HTMLInputElement;
      element.value = value;
      element.dispatchEvent(new Event('input'));
      await fixture.whenStable();
    };
    const save = async (): Promise<void> => {
      (find('runner-policy-form') as HTMLFormElement).dispatchEvent(new Event('submit', { cancelable: true }));
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
    return { fixture, root, find, choose, select, type, save, writes, reads: () => reads, settle, hold, resume };
  }

  const accountScope: RunnerPolicyScope = { kind: 'account', accountId: OWNER_ACCOUNT_ID };
  const projectScope: RunnerPolicyScope = { kind: 'project', slug: 'team-console' };

  it('pins the account default to one runner, offering live runners only, and says when it applies', async () => {
    const { root, find, choose, select, save, writes } = await render(accountScope);
    expect(find('policy-mode-inherit')).toBeNull();
    expect(find('runner-policy-effective')?.textContent).toBe('Сейчас: любой разрешённый раннер.');
    await choose('pinned');
    const options = [...(find<HTMLSelectElement>('policy-pinned')?.options ?? [])].map((option) => option.text);
    expect(options).toEqual(['Выберите раннер', 'Mac', 'VPS']);
    await select('policy-pinned', VPS);
    await save();
    expect(writes).toEqual([{ scope: accountScope, policy: { mode: 'pinned', runner: VPS } }]);
    expect(find('runner-policy-saved')?.textContent).toContain('Сохранено. Действует со следующего задания.');
    expect(find('runner-policy-effective')?.textContent).toBe('Сейчас: только VPS.');
    expect(root.textContent).toContain('Подключать раннеры заново не нужно.');
  });

  it('builds a failover with ordered fallbacks and a threshold', async () => {
    const third = runnerFixture({ id: '01M6YSNJ000000000000000R04', name: 'Box' });
    const { root, find, choose, select, type, save, writes, fixture } = await render(accountScope, {
      runners: [...RUNNERS, third],
    });
    await choose('failover');
    await select('policy-preferred', MAC);
    await select('policy-add-fallback', VPS);
    await select('policy-add-fallback', third.id);
    expect([...root.querySelectorAll('[data-testid="policy-fallback"]')].map((row) => row.textContent?.trim())).toEqual([
      'VPS',
      'Box',
    ]);
    (root.querySelector('[aria-label="Поднять Box выше"]') as HTMLButtonElement).click();
    await fixture.whenStable();
    await type('policy-offline', '120');
    await save();
    expect(writes[0]?.policy).toEqual({
      mode: 'failover',
      preferred: MAC,
      fallback: [third.id, VPS],
      offline_after_seconds: 120,
    });
    expect(find('runner-policy-effective')?.textContent).toBe('Сейчас: Mac, а если он молчит 120 с — Box, VPS.');
  });

  it('refuses an incomplete form before anything is sent', async () => {
    const { root, choose, select, type, save, writes } = await render(accountScope);
    await choose('pinned');
    await save();
    expect(root.textContent).toContain('Выберите раннер.');
    await choose('failover');
    await select('policy-preferred', MAC);
    await save();
    expect(root.textContent).toContain('Добавьте хотя бы один запасной раннер.');
    await select('policy-add-fallback', VPS);
    await type('policy-offline', '5');
    await save();
    expect(root.textContent).toContain('Введите целое число секунд от 30 до 86400.');
    expect(writes).toEqual([]);
  });

  it('lets a project follow the account default again (PUT null)', async () => {
    const pinned: RunnerPolicy = { mode: 'pinned', runner: MAC };
    const { find, choose, save, writes } = await render(projectScope, {
      read: () => ({ ok: true, value: { policy: pinned, effective: pinned } }),
    });
    expect(find<HTMLInputElement>('policy-mode-pinned')?.checked).toBe(true);
    await choose('inherit');
    await save();
    expect(writes).toEqual([{ scope: projectScope, policy: null }]);
    expect(find('runner-policy-effective')?.textContent).toBe('Сейчас, как в аккаунте: любой разрешённый раннер.');
  });

  it('names a revoked runner a stored policy still points at, and says why the Worker refuses it', async () => {
    const stale: RunnerPolicy = { mode: 'pinned', runner: OLD };
    const { find, save } = await render(projectScope, {
      read: () => ({ ok: true, value: { policy: stale, effective: stale } }),
      write: () => ({ ok: false, failure: { kind: 'invalid', slug: 'runner-policy-invalid', field: 'runner' } }),
    });
    expect(find('runner-policy-effective')?.textContent).toBe('Сейчас: только Old Mac (отозван).');
    expect(find<HTMLSelectElement>('policy-pinned')?.selectedOptions[0]?.text).toBe('Old Mac (отозван)');
    await save();
    expect(find('runner-policy-error')?.textContent).toContain('отозван или не принадлежит аккаунту');
  });

  it.each([
    [{ kind: 'forbidden', slug: 'owner-only', field: null }, 'Это может сделать только владелец аккаунта.'],
    [{ kind: 'offline', slug: null, field: null }, 'Нет сети.'],
  ] as const)('keeps the form with the reason when saving fails: %j', async (failure, message) => {
    const { find, save } = await render(accountScope, { write: () => ({ ok: false, failure }) });
    await save();
    expect(find('runner-policy-error')?.textContent).toContain(message);
    expect(find('runner-policy-saved')?.textContent?.trim()).toBe('');
  });

  it('holds the controls while saving', async () => {
    const { find, save, hold, resume, writes } = await render(accountScope);
    hold();
    void save();
    await new Promise((resolve) => setTimeout(resolve));
    expect(find('runner-policy-save')?.getAttribute('aria-disabled')).toBe('true');
    expect(find<HTMLInputElement>('policy-mode-any')?.disabled).toBe(true);
    await save();
    expect(writes).toHaveLength(1);
    await resume();
    expect(find('runner-policy-save')?.getAttribute('aria-disabled')).toBeNull();
  });

  it('turns off the modes that need runners the account does not have', async () => {
    const one = await render(accountScope, { runners: [runnerFixture()] });
    expect(one.find<HTMLInputElement>('policy-mode-pinned')?.disabled).toBe(false);
    expect(one.find<HTMLInputElement>('policy-mode-failover')?.disabled).toBe(true);
    expect(one.root.textContent).toContain('Нужно хотя бы два раннера.');
    TestBed.resetTestingModule();
    const none = await render(accountScope, { runners: [] });
    expect(none.find<HTMLInputElement>('policy-mode-pinned')?.disabled).toBe(true);
    expect(none.root.textContent).toContain('Сначала подключите раннер.');
  });

  it('tells the parent what it saved', async () => {
    const { fixture, choose, save } = await render(accountScope);
    const saved: RunnerPolicyDto[] = [];
    fixture.componentInstance.saved.subscribe((dto) => saved.push(dto));
    await choose('any');
    await save();
    expect(saved).toEqual([{ policy: { mode: 'any' }, effective: { mode: 'any' } }]);
  });

  it('on a new revision refreshes the summary but keeps the owner’s unsaved edits', async () => {
    let effective: RunnerPolicy = { mode: 'any' };
    const { fixture, find, choose, reads, settle } = await render(projectScope, {
      read: () => ({ ok: true, value: { policy: null, effective } }),
    });
    await choose('pinned');
    effective = { mode: 'pinned', runner: VPS };
    const before = reads();
    fixture.componentRef.setInput('revision', 1);
    await settle();
    expect(reads()).toBe(before + 1);
    expect(find('runner-policy-effective')?.textContent).toBe('Сейчас, как в аккаунте: только VPS.');
    expect(find<HTMLInputElement>('policy-mode-pinned')?.checked).toBe(true);
  });

  it('shows a failed read with Try again, and reloads only when the scope really changes', async () => {
    let failing = true;
    const { find, fixture, reads, settle } = await render(projectScope, {
      read: () =>
        failing ? { ok: false, failure: { kind: 'forbidden', slug: 'owner-only', field: null } } : { ok: true, value: ANY },
    });
    expect(find('runner-policy-load-error')?.textContent).toContain('Это может сделать только владелец аккаунта.');
    failing = false;
    (find('runner-policy-load-error')?.querySelector('button') as HTMLButtonElement).click();
    await settle();
    expect(find('runner-policy-form')).not.toBeNull();
    const before = reads();
    fixture.componentRef.setInput('scope', { kind: 'project', slug: 'team-console' });
    await settle();
    expect(reads()).toBe(before);
    fixture.componentRef.setInput('scope', { kind: 'project', slug: 'storify' });
    await settle();
    expect(reads()).toBe(before + 1);
  });
});
