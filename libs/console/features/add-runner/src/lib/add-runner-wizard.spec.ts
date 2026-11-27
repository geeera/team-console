import { LiveAnnouncer } from '@angular/cdk/a11y';
import { signal as signalOf } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  ENROLMENT_INTENT_FIXTURE_ID,
  EnrolmentWatch,
  RUNNER_FIXTURE_IDS,
  RunnerCheckWatch,
  RunnersApi,
  enrolmentIntentFixture,
  pendingIntentFixture,
  runnerCheckFixture,
  runnerFixture,
  type RunnerCheck,
  type RunnerResult,
} from '@console/entities/runner';
import { provideConsoleI18n } from '@console/shared/i18n';
import { DIALOG_DATA, DialogRef, Sheet, SheetCloseGuard, Toaster } from '@console/shared/ui';
import {
  OWNER_ACCOUNT_ID,
  type CreateEnrolmentIntentInput,
  type EnrolmentIntentCreatedDto,
  type EnrolmentIntentDto,
  type RunnerDto,
} from '@shared/contracts';
import { AddRunnerWizard, type AddRunnerData } from './add-runner-wizard';
import { APPROVE_ARM_MS, countryLabelOf, fingerprintSpokenOf, minutesLeftOf } from './add-runner.model';
import { RunnerCheckFlow } from './runner-check-flow';

const SETUP = `sudo /usr/local/lib/team-console-runner/bin/team-console-runner setup --url https://console.example --enrolment ${ENROLMENT_INTENT_FIXTURE_ID}`;
const CREATED: EnrolmentIntentCreatedDto = {
  intentId: ENROLMENT_INTENT_FIXTURE_ID,
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  command: SETUP,
  installCommands: { version: '0.3.0', 'darwin-arm64': 'ARM ONE-LINER', 'darwin-x64': 'INTEL ONE-LINER' },
  linuxInstall: null,
};
const PROJECTS = [
  { slug: 'team-console', displayName: 'Team Console' },
  { slug: 'storify', displayName: 'Storify' },
];
const failed = (kind: string, slug: string | null = null) =>
  ({ ok: false, failure: { kind, slug, field: null } }) as RunnerResult<never>;

/** The watch is driven by hand: the spec flips the intent the way a poll would. */
class ManualWatch {
  readonly intent = signalOf<EnrolmentIntentDto | null>(null);
  readonly runner = signalOf<ReturnType<typeof runnerFixture> | null>(null);
  readonly minimumVersion = signalOf<string | null>('0.2.0');
  readonly failedPolls = signalOf(0);
  readonly stopped = signalOf<'session-expired' | 'forbidden' | 'not-found' | null>(null);
  readonly gaveUp = signalOf(false);
  readonly rateLimitedFor = signalOf<number | null>(null);
  readonly watchIntent = vi.fn();
  readonly watchRunner = vi.fn();
  readonly stop = vi.fn();
  readonly checkNow = vi.fn(async () => undefined);
}

describe('AddRunnerWizard (#634 PR 4)', () => {
  async function render({
    created = (): RunnerResult<EnrolmentIntentCreatedDto> => ({ ok: true, value: CREATED }),
    approve = (): RunnerResult<EnrolmentIntentDto> => ({
      ok: true,
      value: enrolmentIntentFixture({ state: 'approved', runnerId: RUNNER_FIXTURE_IDS.mac }),
    }),
    reread = (): RunnerResult<EnrolmentIntentDto> => ({ ok: true, value: enrolmentIntentFixture() }),
    withdraw = (): RunnerResult<null> => ({ ok: true, value: null }),
    owners = (): RunnerResult<number> => ({ ok: true, value: 1 }),
    startCheck = (): RunnerResult<RunnerCheck> => ({ ok: true, value: runnerCheckFixture() }),
    readCheck = (): RunnerResult<RunnerCheck> => ({ ok: true, value: runnerCheckFixture() }),
    confirm = true,
  } = {}) {
    const close = vi.fn();
    const ref = { close, disableClose: false };
    const guard = new SheetCloseGuard();
    const watch = new ManualWatch();
    const api = {
      ownerCount: vi.fn(async () => owners()),
      createEnrolmentIntent: vi.fn(async (_account: string, _input: CreateEnrolmentIntentInput) => created()),
      approveEnrolmentIntent: vi.fn(async (_account: string, _id: string, _fingerprint: string) => approve()),
      enrolmentIntent: vi.fn(async () => reread()),
      withdrawEnrolmentIntent: vi.fn(
        async (_account: string, _id: string, _options?: { keepalive?: boolean }) => withdraw(),
      ),
      startCheck: vi.fn(async (_account: string, _runner: string) => startCheck()),
      check: vi.fn(async (_account: string, _runner: string, _check: string) => readCheck()),
    };
    const sheet = { confirm: vi.fn(async () => confirm) };
    const toaster = { show: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        provideConsoleI18n(),
        { provide: DialogRef, useValue: ref },
        { provide: SheetCloseGuard, useValue: guard },
        { provide: Sheet, useValue: sheet },
        { provide: Toaster, useValue: toaster },
        { provide: RunnersApi, useValue: api },
        {
          provide: DIALOG_DATA,
          useValue: {
            accountId: OWNER_ACCOUNT_ID,
            projects: PROJECTS,
            releaseVersion: '0.3.0',
          } satisfies AddRunnerData,
        },
      ],
    });
    TestBed.overrideComponent(AddRunnerWizard, {
      set: {
        providers: [{ provide: EnrolmentWatch, useValue: watch }, RunnerCheckWatch, RunnerCheckFlow],
      },
    });
    const announce = vi.spyOn(TestBed.inject(LiveAnnouncer), 'announce').mockResolvedValue();
    const fixture = TestBed.createComponent(AddRunnerWizard);
    document.body.appendChild(fixture.nativeElement);
    const root = fixture.nativeElement as HTMLElement;
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 4; i += 1) {
        await fixture.whenStable();
        await new Promise((resolve) => setTimeout(resolve));
      }
    };
    await settle();
    const find = (id: string): HTMLElement | null => root.querySelector(`[data-testid="${id}"]`);
    const type = async (value: string): Promise<void> => {
      const input = find('wizard-name') as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event('input'));
      await settle();
    };
    const submit = async (): Promise<void> => {
      (root.querySelector('form') as HTMLFormElement).dispatchEvent(
        new Event('submit', { cancelable: true }),
      );
      await settle();
    };
    const click = async (id: string): Promise<void> => {
      (find(id) as HTMLElement).click();
      await settle();
    };
    const flip = async (intent: EnrolmentIntentDto): Promise<void> => {
      watch.intent.set(intent);
      await settle();
    };
    const toCommand = async (): Promise<void> => {
      await type('Mac mini');
      await submit();
    };
    /** Waits out the #878 mis-click guard, as an owner comparing the code does. */
    const arm = async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(APPROVE_ARM_MS);
      await settle();
    };
    const toConfirm = async (): Promise<void> => {
      await toCommand();
      await flip(enrolmentIntentFixture());
      await arm();
    };
    /** Approves, then the runner comes on line as the list would show it. */
    const toOnline = async (runner: Partial<RunnerDto> = {}): Promise<void> => {
      await toConfirm();
      await click('wizard-approve');
      watch.runner.set(runnerFixture({ online: true, ...runner }));
      await settle();
    };
    return {
      fixture,
      toOnline,
      announce,
      root,
      find,
      type,
      submit,
      click,
      flip,
      arm,
      toCommand,
      toConfirm,
      settle,
      api,
      watch,
      close,
      ref,
      guard,
      sheet,
      toaster,
    };
  }

  beforeEach(() => {
    vi.useFakeTimers({
      shouldAdvanceTime: true,
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('takes every close itself, so a live request is never dropped without asking (§3.6)', async () => {
    const { ref, guard } = await render();
    expect(ref.disableClose).toBe(true);
    expect(guard.request()).toBe(true);
  });

  it('starts on step 1 with all projects, Mac, the .pkg line and no D3 line for a sole owner', async () => {
    const { find, root } = await render();
    expect(find('wizard-step')?.textContent).toContain('Шаг 1 из 4 · Параметры');
    expect((find('runner-scope-all') as HTMLInputElement).checked).toBe(true);
    expect((find('wizard-platform-mac') as HTMLInputElement).checked).toBe(true);
    expect(find('wizard-pkg-later')?.textContent).toContain('Позже: установщик .pkg для Mac');
    expect(find('runner-scope-owners')).toBeNull();
    expect(root.textContent).toContain('Изоляция: Отдельный пользователь macOS');
  });

  it('keeps the D3 line when the owner count fails to load (decision 5)', async () => {
    const { find } = await render({ owners: () => failed('offline') });
    expect(find('runner-scope-owners')?.textContent).toContain('Если в аккаунте есть другие владельцы');
  });

  it('refuses an empty name and focuses the field', async () => {
    const { submit, api, root } = await render();
    await submit();
    expect(api.createEnrolmentIntent).not.toHaveBeenCalled();
    expect(root.textContent).toContain('Введите название раннера');
    expect(document.activeElement?.getAttribute('data-testid')).toBe('wizard-name');
  });

  it('creates a container intent for Linux and shows the API’s two commands byte for byte (#634 PR 7)', async () => {
    const linuxInstall = {
      version: '0.3.0',
      image: `ghcr.io/geeera/team-console-runner:0.3.0@sha256:${'a'.repeat(64)}`,
      prepare: 'PREPARE THE HOST',
      enrol: 'ENROL WITH TC_ENROLMENT',
    };
    const { type, find, submit, settle, api, watch, close, root } = await render({
      created: () => ({ ok: true, value: { ...CREATED, installCommands: null, linuxInstall } }),
    });
    await type('VPS');
    (find('wizard-platform-linux') as HTMLInputElement).click();
    await settle();
    expect(root.textContent).toContain('Изоляция: Контейнер');
    expect(find('wizard-submit')?.textContent).toContain('Показать команду');
    await submit();
    expect(api.createEnrolmentIntent).toHaveBeenCalledWith(OWNER_ACCOUNT_ID, {
      name: 'VPS',
      projectScope: 'all',
      allowedProjects: [],
      isolation: 'container',
    });
    expect(close).not.toHaveBeenCalled();
    expect(watch.watchIntent).toHaveBeenCalledWith(
      OWNER_ACCOUNT_ID,
      ENROLMENT_INTENT_FIXTURE_ID,
      CREATED.expiresAt,
    );
    expect(find('wizard-step')?.textContent).toContain('Шаг 2 из 4 · Команда');
    expect(document.activeElement?.textContent).toContain('Выполните две команды на машине «VPS»');
    const text = (id: string): string =>
      find(id)?.querySelector('[data-testid="copy-code-text"]')?.textContent ?? '';
    expect(text('wizard-linux-prepare')).toBe('PREPARE THE HOST');
    expect(text('wizard-command')).toBe('ENROL WITH TC_ENROLMENT');
    expect(find('wizard-linux-socket')?.textContent).toContain(
      'Сокет docker.sock не нужен и не используется. Контейнер раннера запускает задания через сокет rootless podman пользователя tcrunner: /var/lib/team-console-runner/podman.sock.',
    );
    expect(find('wizard-arch-darwin-arm64')).toBeNull();
    expect(find('wizard-runbook')).toBeNull();
    // Both blocks are named regions with their own copy button (a11y).
    const regions = [...root.querySelectorAll('[data-testid="wizard-linux"] [role="region"]')].map((region) =>
      region.getAttribute('aria-label'),
    );
    expect(regions).toEqual(['Команда подготовки машины', 'Команда подключения раннера']);
  });

  it('withdraws the Linux request and hands over to the code dialog when no image is named (decision 1)', async () => {
    const { type, find, submit, close, settle, api } = await render({
      created: () => ({ ok: true, value: { ...CREATED, installCommands: null, linuxInstall: null } }),
    });
    await type('VPS');
    (find('wizard-platform-linux') as HTMLInputElement).click();
    await settle();
    await submit();
    expect(api.createEnrolmentIntent).toHaveBeenCalledWith(
      OWNER_ACCOUNT_ID,
      expect.objectContaining({ isolation: 'container' }),
    );
    expect(api.withdrawEnrolmentIntent).toHaveBeenCalledWith(OWNER_ACCOUNT_ID, ENROLMENT_INTENT_FIXTURE_ID);
    expect(close).toHaveBeenCalledWith({
      kind: 'code',
      name: 'VPS',
      projectScope: 'all',
      allowedProjects: [],
    });
  });

  it('creates a user intent and shows the API one-liner per processor, byte for byte', async () => {
    const { toCommand, find, api, watch, settle } = await render();
    await toCommand();
    expect(api.createEnrolmentIntent).toHaveBeenCalledWith(OWNER_ACCOUNT_ID, {
      name: 'Mac mini',
      projectScope: 'all',
      allowedProjects: [],
      isolation: 'user',
    });
    expect(watch.watchIntent).toHaveBeenCalledWith(
      OWNER_ACCOUNT_ID,
      ENROLMENT_INTENT_FIXTURE_ID,
      CREATED.expiresAt,
    );
    expect(find('wizard-step')?.textContent).toContain('Шаг 2 из 4 · Команда');
    expect(document.activeElement?.hasAttribute('data-step-heading')).toBe(true);
    const command = (): string =>
      find('wizard-command')?.querySelector('[data-testid="copy-code-text"]')?.textContent ?? '';
    expect(command()).toBe('ARM ONE-LINER');
    (find('wizard-arch-darwin-x64') as HTMLInputElement).click();
    await settle();
    expect(command()).toBe('INTEL ONE-LINER');
    // Switching the processor swaps text only: no second intent (N2).
    expect(api.createEnrolmentIntent).toHaveBeenCalledTimes(1);
    expect(find('wizard-runbook')).toBeNull();
  });

  it('shows the runbook path with the setup line when the release has no one-liner (S2)', async () => {
    const { toCommand, find } = await render({
      created: () => ({ ok: true, value: { ...CREATED, installCommands: null } }),
    });
    await toCommand();
    expect(find('wizard-runbook')?.textContent).toContain('Скачайте и проверьте выпуск 0.3.0.');
    expect(find('wizard-command')?.querySelector('[data-testid="copy-code-text"]')?.textContent).toBe(SETUP);
    expect(find('wizard-runbook-link')?.getAttribute('href')).toContain(
      '#get-a-release-and-verify-it-both-backends',
    );
  });

  // #817: the API makes no request when it has no origin for a command, and answers 503 console-origin-misconfigured.
  it('offers the code path when the API has no command, and never builds one', async () => {
    const { toCommand, find, click, close } = await render({
      created: () => failed('error', 'console-origin-misconfigured'),
    });
    await toCommand();
    expect(find('wizard-error')?.textContent).toContain('Консоль сейчас не может собрать команду');
    expect(find('wizard-command')).toBeNull();
    await click('wizard-to-code');
    expect(close).toHaveBeenCalledWith(expect.objectContaining({ kind: 'code', name: 'Mac mini' }));
  });

  it.each([
    [failed('conflict', 'enrolment-intent-limit'), 'Уже открыто три запроса'],
    [failed('rate-limited', 'rate-limited'), 'Слишком много запросов на подключение за час'],
    [failed('invalid', 'allowed-projects-invalid'), 'Среди проектов есть архивный или чужой'],
    [failed('offline'), 'Нет сети'],
  ])('words a refused create in step 1 and offers to retry', async (answer, text) => {
    const { toCommand, find } = await render({ created: () => answer });
    await toCommand();
    expect(find('wizard-error')?.getAttribute('role')).toBe('alert');
    expect(find('wizard-error')?.textContent).toContain(text);
    expect(find('wizard-submit')?.textContent).toContain('Повторить');
  });

  it('moves to the confirmation when a machine binds: fingerprint, host and country as text', async () => {
    const { toConfirm, find } = await render();
    await toConfirm();
    expect(find('wizard-step')?.textContent).toContain('Шаг 3 из 4 · Подтверждение');
    expect(find('wizard-fingerprint')?.textContent?.trim()).toBe('7K2Q-M9XD');
    expect(find('wizard-hostname')?.tagName).toBe('BDI');
    expect(find('wizard-hostname')?.textContent).toBe('Kirills-MacBook-Pro.local');
    expect(find('wizard-country')?.textContent).toContain('(DE)');
    // Decision 6: the heading has focus, never «Подтвердить»; «Отклонить» comes first.
    expect(document.activeElement?.hasAttribute('data-step-heading')).toBe(true);
    const buttons = [...(find('wizard-reject')?.parentElement?.querySelectorAll('button') ?? [])];
    expect(buttons.map((button) => button.getAttribute('data-testid'))).toEqual([
      'wizard-reject',
      'wizard-approve',
    ]);
    expect(buttons.every((button) => button.type === 'button')).toBe(true);
  });

  it('approves with the fingerprint it displayed and moves to waiting for the first signal', async () => {
    const { toConfirm, click, api, watch, find } = await render();
    await toConfirm();
    await click('wizard-approve');
    expect(api.approveEnrolmentIntent).toHaveBeenCalledWith(
      OWNER_ACCOUNT_ID,
      ENROLMENT_INTENT_FIXTURE_ID,
      '7K2Q-M9XD',
    );
    expect(watch.watchRunner).toHaveBeenCalledWith(OWNER_ACCOUNT_ID, RUNNER_FIXTURE_IDS.mac);
    expect(find('wizard-step')?.textContent).toContain('Шаг 4 из 4 · На связи');
    expect(find('wizard-approved-waiting')).not.toBeNull();
  });

  it('ignores approve for a second after «Подтвердить» takes the withdraw button’s spot (#878)', async () => {
    const { toCommand, flip, click, find, api, settle } = await render();
    await toCommand();
    // The click aimed at «Отозвать запрос» lands after the poll flipped the step.
    await flip(enrolmentIntentFixture());
    expect(find('wizard-approve')?.getAttribute('aria-disabled')).toBe('true');
    await click('wizard-approve');
    expect(api.approveEnrolmentIntent).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(APPROVE_ARM_MS / 2);
    await settle();
    await click('wizard-approve');
    expect(api.approveEnrolmentIntent).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(APPROVE_ARM_MS / 2);
    await settle();
    expect(find('wizard-approve')?.hasAttribute('aria-disabled')).toBe(false);
    await click('wizard-approve');
    expect(api.approveEnrolmentIntent).toHaveBeenCalledTimes(1);
  });

  it('re-reads after a 409 changed, shows the new code and never approves on its own', async () => {
    const { toConfirm, click, arm, api, find } = await render({
      approve: () => failed('conflict', 'enrolment-fingerprint-mismatch'),
      reread: () => ({ ok: true, value: enrolmentIntentFixture({ fingerprint: 'ZZZZ-1111' }) }),
    });
    await toConfirm();
    await click('wizard-approve');
    expect(api.approveEnrolmentIntent).toHaveBeenCalledTimes(1);
    expect(find('wizard-fingerprint')?.textContent?.trim()).toBe('ZZZZ-1111');
    expect(find('wizard-error')?.textContent).toContain('Запрос изменился');
    // The second click of a double click lands on the new code: the guard holds it too.
    await click('wizard-approve');
    expect(api.approveEnrolmentIntent).toHaveBeenCalledTimes(1);
    await arm();
    await click('wizard-approve');
    expect(api.approveEnrolmentIntent).toHaveBeenLastCalledWith(
      OWNER_ACCOUNT_ID,
      ENROLMENT_INTENT_FIXTURE_ID,
      'ZZZZ-1111',
    );
  });

  it('reads a 404 on approve as expired when the intent says so', async () => {
    const { toConfirm, click, find } = await render({
      approve: () => failed('not-found', 'enrolment-not-found'),
      reread: () => ({ ok: true, value: enrolmentIntentFixture({ state: 'expired' }) }),
    });
    await toConfirm();
    await click('wizard-approve');
    expect(find('wizard-expired')?.textContent).toContain('Запрос истёк');
  });

  it('keeps «Подтвердить» unusable for a suspended account', async () => {
    const { toConfirm, click, find, api } = await render({
      approve: () => failed('forbidden', 'account-suspended'),
    });
    await toConfirm();
    await click('wizard-approve');
    expect(find('wizard-error')?.textContent).toContain('Аккаунт приостановлен');
    expect(find('wizard-approve')?.getAttribute('aria-disabled')).toBe('true');
    await click('wizard-approve');
    expect(api.approveEnrolmentIntent).toHaveBeenCalledTimes(1);
  });

  it('rejects by withdrawing and offers a new command that keeps the parameters', async () => {
    const { toConfirm, click, api, find, watch } = await render();
    await toConfirm();
    await click('wizard-reject');
    expect(api.withdrawEnrolmentIntent).toHaveBeenCalledWith(OWNER_ACCOUNT_ID, ENROLMENT_INTENT_FIXTURE_ID);
    expect(watch.stop).toHaveBeenCalled();
    expect(find('wizard-rejected')?.textContent).toContain('Запрос отклонён');
    await click('wizard-again');
    expect(api.createEnrolmentIntent).toHaveBeenCalledTimes(2);
    expect(api.createEnrolmentIntent.mock.calls[1]?.[1]).toMatchObject({ name: 'Mac mini' });
    expect(find('wizard-step')?.textContent).toContain('Шаг 2 из 4');
  });

  it.each([
    ['expired', 'wizard-expired', 'Запрос истёк'],
    ['withdrawn', 'wizard-withdrawn', 'Запрос отозван'],
  ] as const)('ends on %s from a poll', async (state, id, text) => {
    const { toCommand, flip, find } = await render();
    await toCommand();
    await flip(pendingIntentFixture({ state }));
    expect(find(id)?.textContent).toContain(text);
  });

  it('flips to «Раннер на связи» when the runner comes online, with the below-minimum warning', async () => {
    const { toConfirm, click, watch, settle, find } = await render();
    await toConfirm();
    await click('wizard-approve');
    watch.runner.set(runnerFixture({ online: true, version: '0.1.0', belowMinimum: true }));
    await settle();
    expect(find('wizard-online')?.textContent).toContain('Раннер «Mac mini» подключён');
    expect(find('wizard-behind')?.textContent).toContain('ниже минимальной 0.2.0');
    expect(find('wizard-done')?.textContent).toContain('Готово');
  });

  it('says what to check after five minutes offline, and keeps waiting (decision 4)', async () => {
    const { toConfirm, click, find, fixture } = await render();
    await toConfirm();
    await click('wizard-approve');
    expect(find('wizard-slow')).toBeNull();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await fixture.whenStable();
    expect(find('wizard-slow')?.textContent).toContain('self-check');
  });

  it('offers a manual re-check once the watch stops polling the offline runner (#878)', async () => {
    const { toConfirm, click, find, watch, settle } = await render();
    await toConfirm();
    await click('wizard-approve');
    watch.gaveUp.set(true);
    await settle();
    expect(find('wizard-slow')?.textContent).toContain('Раннер пока не вышел на связь');
    expect(find('wizard-stopped')?.textContent).toContain('Консоль перестала проверять сама');
    expect(find('wizard-approved-waiting')).toBeNull();
    watch.checkNow.mockImplementationOnce(async () => {
      watch.runner.set(runnerFixture({ online: true }));
    });
    await click('wizard-recheck');
    expect(watch.checkNow).toHaveBeenCalledTimes(1);
    expect(find('wizard-online')?.textContent).toContain('Раннер «Mac mini» подключён');
  });

  it('asks before closing a live request, withdraws it, and closes even when the withdraw fails', async () => {
    const { toCommand, guard, sheet, api, close, toaster, settle } = await render({
      withdraw: () => failed('offline'),
    });
    await toCommand();
    guard.request();
    await settle();
    expect(sheet.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Закрыть и отозвать запрос?', tone: 'danger' }),
    );
    expect(api.withdrawEnrolmentIntent).toHaveBeenCalled();
    expect(toaster.show).toHaveBeenCalledWith('Не удалось отозвать запрос. Он истечёт сам через 10 минут.');
    expect(close).toHaveBeenCalledWith({ kind: 'closed', enrolled: false });
  });

  it('withdraws a live request once when the sheet goes away without the dialog (#878)', async () => {
    const { toConfirm, fixture, api, settle } = await render();
    await toConfirm();
    fixture.destroy();
    await settle();
    expect(api.withdrawEnrolmentIntent).toHaveBeenCalledTimes(1);
    expect(api.withdrawEnrolmentIntent).toHaveBeenCalledWith(OWNER_ACCOUNT_ID, ENROLMENT_INTENT_FIXTURE_ID, {
      keepalive: true,
    });
  });

  it('withdraws on pagehide with keepalive and not again when the sheet then goes away (#878)', async () => {
    const { toCommand, fixture, api, settle } = await render();
    await toCommand();
    window.dispatchEvent(new Event('pagehide'));
    await settle();
    expect(api.withdrawEnrolmentIntent).toHaveBeenCalledWith(OWNER_ACCOUNT_ID, ENROLMENT_INTENT_FIXTURE_ID, {
      keepalive: true,
    });
    fixture.destroy();
    await settle();
    expect(api.withdrawEnrolmentIntent).toHaveBeenCalledTimes(1);
  });

  it('logs a failed withdraw on leaving rather than dropping it (#878)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { toCommand, fixture, settle } = await render({ withdraw: () => failed('session-expired') });
      await toCommand();
      fixture.destroy();
      await settle();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('session-expired'));
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    ['step 1', false],
    ['after the close dialog withdrew it', true],
  ] as const)('sends no second withdraw on leaving %s', async (_case, live) => {
    const { toCommand, guard, fixture, api, settle } = await render();
    if (live) {
      await toCommand();
      guard.request();
      await settle();
    }
    fixture.destroy();
    await settle();
    expect(api.withdrawEnrolmentIntent).toHaveBeenCalledTimes(live ? 1 : 0);
    if (live) {
      expect(api.withdrawEnrolmentIntent).toHaveBeenCalledWith(OWNER_ACCOUNT_ID, ENROLMENT_INTENT_FIXTURE_ID);
    }
  });

  it('stays open when the owner chooses «Остаться»', async () => {
    const { toCommand, guard, api, close, settle } = await render({ confirm: false });
    await toCommand();
    guard.request();
    await settle();
    expect(api.withdrawEnrolmentIntent).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it('closes step 1 at once', async () => {
    const { guard, close, sheet, settle } = await render();
    guard.request();
    await settle();
    expect(sheet.confirm).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith({ kind: 'closed', enrolled: false });
  });

  it('says the console asked to slow down on a 429, not that it is unreachable (#879)', async () => {
    const { toCommand, watch, settle, find } = await render();
    await toCommand();
    watch.rateLimitedFor.set(30);
    await settle();
    expect(find('wizard-poll-limited')?.getAttribute('role')).toBe('status');
    expect(find('wizard-poll-limited')?.textContent).toContain('Проверим снова через 30 с');
    expect(find('wizard-poll-failing')).toBeNull();
    watch.rateLimitedFor.set(null);
    await settle();
    expect(find('wizard-poll-limited')).toBeNull();
  });

  it('says so after two failed polls and when the session expired', async () => {
    const { toCommand, watch, settle, find } = await render();
    await toCommand();
    watch.failedPolls.set(2);
    await settle();
    expect(find('wizard-poll-failing')?.getAttribute('role')).toBe('status');
    watch.stopped.set('session-expired');
    await settle();
    expect(find('wizard-error')?.textContent).toContain('Сессия истекла');
  });

  describe('the runner check on step 4b (#1059 PR 3, UX §12)', () => {
    const check = (overrides: Partial<RunnerCheck> = {}): RunnerResult<RunnerCheck> => ({
      ok: true,
      value: runnerCheckFixture(overrides),
    });
    const refused = (kind: string, slug: string | null, extra: Record<string, unknown> = {}) =>
      ({ ok: false, failure: { kind, slug, field: null, ...extra } }) as RunnerResult<never>;
    /** Each answer in turn, then the last one for good. */
    const sequence =
      (...answers: RunnerResult<RunnerCheck>[]) =>
      (): RunnerResult<RunnerCheck> =>
        (answers.length > 1 ? answers.shift() : answers[0]) ?? check();
    const stateOf = (root: HTMLElement): string | null | undefined =>
      root.querySelector('[data-testid="wizard-check"]')?.getAttribute('data-state');

    it('starts one check by itself on line, with one announcement, and shows the pass as found, not verified', async () => {
      const { toOnline, settle, root, find, api, announce } = await render({
        readCheck: sequence(check({ state: 'running' }), check({ state: 'passed', claudeVersion: '2.1.4' })),
      });
      await toOnline();
      expect(api.startCheck).toHaveBeenCalledWith(OWNER_ACCOUNT_ID, RUNNER_FIXTURE_IDS.mac);
      const said = announce.mock.calls.map(([message]) => message);
      expect(said).toContain('Раннер Mac mini на связи. Проверяем, запускается ли Claude.');
      expect(said).not.toContain('Раннер Mac mini на связи.');
      expect(stateOf(root)).toBe('queued');

      await vi.advanceTimersByTimeAsync(2_000);
      await settle();
      expect(stateOf(root)).toBe('running');
      await vi.advanceTimersByTimeAsync(2_000);
      await settle();
      expect(stateOf(root)).toBe('passed');
      expect(find('wizard-check-version')?.textContent).toBe('2.1.4');
      expect(find('wizard-check')?.textContent).toContain('вход в Claude найден');
      expect(root.textContent).not.toMatch(/вход проверен|всё работает|готов к заданиям/i);
      expect(announce).toHaveBeenCalledWith(
        'Проверка прошла: Claude Code 2.1.4 запускается на раннере.',
        'polite',
      );
      await vi.advanceTimersByTimeAsync(20_000);
      expect(api.startCheck).toHaveBeenCalledTimes(1);
      expect(api.check).toHaveBeenCalledTimes(2);
    });

    it('never moves focus on a result: it stays on the step heading', async () => {
      const { toOnline, settle, root } = await render({
        readCheck: () => check({ state: 'failed', reason: 'timeout' }),
      });
      await toOnline();
      const heading = root.querySelector<HTMLElement>('[data-step-heading]');
      expect(document.activeElement).toBe(heading);
      await vi.advanceTimersByTimeAsync(2_000);
      await settle();
      expect(stateOf(root)).toBe('timeout');
      expect(document.activeElement).toBe(heading);
    });

    it('makes no request for a runner below the minimum and shows C8 with «Как обновить»', async () => {
      const { toOnline, root, find, api } = await render();
      await toOnline({ version: '0.1.0', belowMinimum: true });
      expect(api.startCheck).not.toHaveBeenCalled();
      expect(stateOf(root)).toBe('outdated');
      expect(find('wizard-check-update')).not.toBeNull();
      expect(find('wizard-check-start')).toBeNull();
    });

    it('waits in C0 while the browser is offline, and starts only on the owner’s press', async () => {
      const { toConfirm, click, watch, settle, root, find, api } = await render();
      await toConfirm();
      await click('wizard-approve');
      window.dispatchEvent(new Event('offline'));
      watch.runner.set(runnerFixture({ online: true }));
      await settle();
      expect(api.startCheck).not.toHaveBeenCalled();
      expect(stateOf(root)).toBe('idle');
      expect(find('wizard-check-start')?.getAttribute('aria-disabled')).toBe('true');
      find('wizard-check-start')?.click();
      await settle();
      expect(api.startCheck).not.toHaveBeenCalled();

      window.dispatchEvent(new Event('online'));
      await settle();
      expect(api.startCheck).not.toHaveBeenCalled();
      find('wizard-check-start')?.click();
      await settle();
      expect(api.startCheck).toHaveBeenCalledTimes(1);
    });

    it('retries a runner-outdated once, silently, 10 s after the automatic start (N8)', async () => {
      const outdated = refused('error', 'runner-outdated');
      const answers: RunnerResult<RunnerCheck>[] = [outdated, check()];
      const { toOnline, settle, root, api, announce } = await render({
        startCheck: () => answers.shift() ?? check(),
      });
      await toOnline();
      expect(stateOf(root)).toBe('starting');
      await vi.advanceTimersByTimeAsync(9_000);
      expect(api.startCheck).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      await settle();
      expect(api.startCheck).toHaveBeenCalledTimes(2);
      expect(stateOf(root)).toBe('queued');
      expect(announce.mock.calls.map(([message]) => message).join('|')).not.toContain('не умеет');
    });

    it('shows C8 after the second runner-outdated, and never retries a press', async () => {
      const outdated = refused('error', 'runner-outdated');
      const { toOnline, settle, root, api } = await render({ startCheck: () => outdated });
      await toOnline();
      await vi.advanceTimersByTimeAsync(10_000);
      await settle();
      expect(api.startCheck).toHaveBeenCalledTimes(2);
      expect(stateOf(root)).toBe('outdated');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(api.startCheck).toHaveBeenCalledTimes(2);
    });

    it('maps the start’s refusals to their states', async () => {
      for (const [failure, state] of [
        [refused('error', 'runner-offline'), 'offline'],
        [refused('error', 'runner-paused'), 'paused'],
        [refused('revoked', 'runner-revoked'), 'revoked'],
        [refused('invalid', 'runner-check-unsupported'), 'unsupported'],
      ] as const) {
        const { toOnline, root, find } = await render({ startCheck: () => failure });
        await toOnline();
        expect(stateOf(root), state).toBe(state);
        expect(find('wizard-error'), state).toBeNull();
        TestBed.resetTestingModule();
        document.body.innerHTML = '';
      }
    });

    it('sends a 403 to the §6 banner and offers no «Проверить снова» after it (review item 1)', async () => {
      const { toOnline, root, find } = await render({
        startCheck: () => refused('forbidden', 'account-owner-only'),
      });
      await toOnline();
      expect(find('wizard-error')?.getAttribute('role')).toBe('alert');
      expect(find('wizard-error')?.textContent).toContain('только владелец аккаунта');
      expect(stateOf(root)).toBe('idle');
      expect(find('wizard-check-start')).toBeNull();
    });

    it('puts the panel back where it was when a press fails as a request', async () => {
      const answers: RunnerResult<RunnerCheck>[] = [
        refused('error', 'runner-offline'),
        refused('offline', null),
      ];
      const { toOnline, click, root, find } = await render({ startCheck: () => answers.shift() ?? check() });
      await toOnline();
      expect(stateOf(root)).toBe('offline');
      await click('wizard-check-start');
      expect(stateOf(root)).toBe('offline');
      expect(find('wizard-error')).not.toBeNull();
    });

    it('gives up after 4 minutes (C6) and «Проверить снова» re-attaches to the check in flight', async () => {
      const { toOnline, settle, click, root, api } = await render();
      await toOnline();
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      await settle();
      expect(stateOf(root)).toBe('gaveUp');
      const reads = api.check.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(api.check).toHaveBeenCalledTimes(reads);

      await click('wizard-check-start');
      expect(api.startCheck).toHaveBeenCalledTimes(2);
      expect(stateOf(root)).toBe('queued');
      await vi.advanceTimersByTimeAsync(2_000);
      expect(api.check).toHaveBeenLastCalledWith(
        OWNER_ACCOUNT_ID,
        RUNNER_FIXTURE_IDS.mac,
        runnerCheckFixture().id,
      );
    });

    it('turns C2’s sub-line after 30 s in queued', async () => {
      const { toOnline, settle, find } = await render();
      await toOnline();
      expect(find('wizard-check')?.textContent).toContain('Обычно это занимает до 10 секунд');
      await vi.advanceTimersByTimeAsync(30_000);
      await settle();
      expect(find('wizard-check')?.textContent).toContain('Раннер пока не взял проверку');
    });

    it('holds «Проверить снова» after a 429 until Retry-After, with the local time, and starts nothing itself', async () => {
      const { toOnline, settle, root, find, api } = await render({
        startCheck: () => refused('rate-limited', 'rate-limited', { retryAfterSeconds: 90 }),
      });
      await toOnline();
      expect(stateOf(root)).toBe('rateLimited');
      expect(find('wizard-check-title')?.textContent).toMatch(/Проверить снова можно в \d{2}:\d{2}/);
      expect(find('wizard-check-start')?.getAttribute('aria-disabled')).toBe('true');
      await vi.advanceTimersByTimeAsync(90_000);
      await settle();
      expect(find('wizard-check-start')?.getAttribute('aria-disabled')).toBeNull();
      expect(api.startCheck).toHaveBeenCalledTimes(1);
    });

    it('shows a 429 on the watch’s reads in the shared banner and keeps watching (N9)', async () => {
      const answers: RunnerResult<RunnerCheck>[] = [
        refused('rate-limited', 'rate-limited', { retryAfterSeconds: 10 }),
        check({ state: 'running' }),
      ];
      const { toOnline, settle, root, find } = await render({ readCheck: () => answers.shift() ?? check() });
      await toOnline();
      await vi.advanceTimersByTimeAsync(2_000);
      await settle();
      expect(find('wizard-poll-limited')?.textContent).toContain('через 10 с');
      expect(stateOf(root)).toBe('queued');
      await vi.advanceTimersByTimeAsync(10_000);
      await settle();
      expect(find('wizard-poll-limited')).toBeNull();
      expect(stateOf(root)).toBe('running');
    });

    it('closes at once on «Готово» mid-check, without a confirm, and the polling stops with the sheet', async () => {
      const { toOnline, settle, click, fixture, api, sheet, close } = await render({
        readCheck: () => check({ state: 'running' }),
      });
      await toOnline();
      await vi.advanceTimersByTimeAsync(2_000);
      await settle();
      await click('wizard-done');
      expect(sheet.confirm).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledWith({ kind: 'closed', enrolled: true });
      const reads = api.check.mock.calls.length;
      fixture.destroy();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(api.check).toHaveBeenCalledTimes(reads);
    });

    it('gives a Linux runner the Linux credential state and the runbook, not a Mac command', async () => {
      const { toOnline, settle, find, type, submit, flip, arm, click, watch } = await render({
        readCheck: () => check({ state: 'failed', reason: 'credential-missing' }),
        created: () => ({
          ok: true,
          value: {
            ...CREATED,
            installCommands: null,
            linuxInstall: { version: '0.3.0', image: 'img', prepare: 'PREPARE', enrol: 'ENROL' },
          },
        }),
      });
      await type('Build box');
      (find('wizard-platform-linux') as HTMLInputElement).click();
      await settle();
      await submit();
      await flip(enrolmentIntentFixture({ isolation: 'container' }));
      await arm();
      await click('wizard-approve');
      watch.runner.set(runnerFixture({ online: true, isolation: 'container' }));
      await settle();
      await vi.advanceTimersByTimeAsync(2_000);
      await settle();
      expect(find('wizard-check-title')?.textContent).toContain('Ключ API не найден');
      expect(find('wizard-check-setup')).toBeNull();
      expect(find('wizard-check')?.textContent).toContain('--replace-credential');
    });
  });
});

describe('add-runner model', () => {
  it('spells a fingerprint the way it is compared', () => {
    expect(fingerprintSpokenOf('7K2Q-M9XD', 'дефис')).toBe('7 K 2 Q, дефис, M 9 X D');
  });

  it('names the country in the UI language with its code, and passes an unknown one through', () => {
    expect(countryLabelOf('DE', 'ru')).toBe('Германия (DE)');
    expect(countryLabelOf(null, 'ru')).toBeNull();
  });

  it('counts whole minutes left, rounded up, never negative', () => {
    const now = Date.parse('2026-11-11T10:00:00.000Z');
    expect(minutesLeftOf('2026-11-11T10:09:01.000Z', now)).toBe(10);
    expect(minutesLeftOf('2026-11-11T09:59:00.000Z', now)).toBe(0);
  });
});
