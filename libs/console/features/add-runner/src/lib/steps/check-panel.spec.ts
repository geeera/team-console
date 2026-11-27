import { TestBed } from '@angular/core/testing';
import { UNKNOWN_CHECK_REASON } from '@console/entities/runner';
import { provideConsoleI18n } from '@console/shared/i18n';
import { RUNNER_CHECK_REASONS, RUNNER_INSTALLED_LAUNCHER } from '@shared/contracts';
import type { RunnerPlatform } from '../add-runner.model';
import { checkViewOfReason, type CheckView } from '../check-panel.model';
import { AddRunnerCheckPanel } from './check-panel';

const HOSTILE = '<img src=x onerror=alert(1)>';
/** Decision 4: a pass proves Claude Code starts and a credential is there, never that the sign-in works. */
const OVERCLAIMS = /вход проверен|всё работает|готов к заданиям|sign-in (is )?(verified|valid)/i;

describe('AddRunnerCheckPanel (#1059 PR 3, UX §12.4)', () => {
  async function render(
    view: CheckView,
    { platform = 'mac', canStart = true, browserOnline = true, retryReady = true } = {} as {
      platform?: RunnerPlatform;
      canStart?: boolean;
      browserOnline?: boolean;
      retryReady?: boolean;
    },
  ) {
    TestBed.configureTestingModule({ providers: [provideConsoleI18n()] });
    const fixture = TestBed.createComponent(AddRunnerCheckPanel);
    fixture.componentRef.setInput('view', view);
    fixture.componentRef.setInput('platform', platform);
    fixture.componentRef.setInput('canStart', canStart);
    fixture.componentRef.setInput('browserOnline', browserOnline);
    fixture.componentRef.setInput('retryReady', retryReady);
    document.body.appendChild(fixture.nativeElement);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const find = (id: string): HTMLElement | null => root.querySelector(`[data-testid="${id}"]`);
    return { fixture, root, find };
  }

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders a hostile claudeVersion literally inside <bdi> and creates no element from it', async () => {
    const { root, find } = await render({ kind: 'passed', version: HOSTILE });
    const version = find('wizard-check-version');
    expect(version?.tagName).toBe('BDI');
    expect(version?.getAttribute('dir')).toBe('auto');
    expect(version?.textContent).toBe(HOSTILE);
    expect(version?.children).toHaveLength(0);
    expect(root.querySelector('img')).toBeNull();
    expect(find('wizard-check-passed')?.textContent).toContain(`Claude Code ${HOSTILE} запускается`);
  });

  it('words a pass as what was proved and never claims the sign-in was verified', async () => {
    for (const platform of ['mac', 'linux'] as const) {
      const { root, find } = await render({ kind: 'passed', version: '2.1.4' }, { platform });
      expect(find('wizard-check-title')?.textContent).toContain('Проверка прошла');
      expect(root.textContent).toMatch(platform === 'mac' ? /вход в Claude найден/ : /ключ API найден/);
      expect(root.textContent).toContain('Действует ли вход, станет видно на первом задании');
      expect(root.textContent).not.toMatch(OVERCLAIMS);
      TestBed.resetTestingModule();
      document.body.innerHTML = '';
    }
  });

  it('drops the version from the sentence when a pass carries none (N11)', async () => {
    const { find } = await render({ kind: 'passed', version: null });
    expect(find('wizard-check-version')).toBeNull();
    expect(find('wizard-check-passed')?.textContent?.trim()).toMatch(/^Claude Code запускается на раннере/);
  });

  it('falls back to the generic state for an unknown reason, without a platform line or a fix', async () => {
    const { root, find } = await render(checkViewOfReason(UNKNOWN_CHECK_REASON));
    expect(find('wizard-check-title')?.textContent).toContain('Машина не готова к заданиям');
    expect(root.textContent).toContain('эта версия консоли не знает');
    expect(find('wizard-check-self-check')).toBeNull();
    expect(root.textContent).not.toContain(UNKNOWN_CHECK_REASON);
  });

  it.each(['mac', 'linux'] as const)(
    'has copy for every known reason on %s, never a raw key',
    async (platform) => {
      for (const reason of RUNNER_CHECK_REASONS) {
        if (reason === 'rate-limited') {
          continue;
        }
        const { root } = await render(checkViewOfReason(reason), { platform });
        expect(root.textContent, reason).not.toMatch(/runners\.wizard|undefined/);
        expect(root.querySelector('[tc-callout].tc-callout--danger'), reason).toBeNull();
        expect(root.querySelector('[role="alert"]'), reason).toBeNull();
        TestBed.resetTestingModule();
        document.body.innerHTML = '';
      }
    },
  );

  it('gives a Mac the credential fix as a setup line without --url (N7)', async () => {
    const { find, root } = await render({ kind: 'credential', cause: 'missing' });
    expect(find('wizard-check-title')?.textContent).toContain('Вход в Claude не найден');
    const command = find('wizard-check-setup')?.querySelector('[data-testid="copy-code-text"]')?.textContent;
    expect(command).toBe(`sudo ${RUNNER_INSTALLED_LAUNCHER} setup --only credential,check`);
    expect(root.textContent).not.toContain('--url');
    expect(root.querySelector('[role="region"]')?.getAttribute('aria-label')).toBe(
      'Команда повтора шага setup',
    );
  });

  it.each(['unreadable', 'notAllowed'] as const)(
    'replaces a saved sign-in that is %s, since setup keeps one otherwise, and says to revoke the old token',
    async (cause) => {
      const { find, root } = await render({ kind: 'credential', cause });
      const command = find('wizard-check-setup')?.querySelector(
        '[data-testid="copy-code-text"]',
      )?.textContent;
      expect(command).toBe(
        `sudo ${RUNNER_INSTALLED_LAUNCHER} setup --only credential,check --replace-credential`,
      );
      expect(root.textContent).not.toContain('--url');
      expect(root.textContent).toContain('заменит сохранённый вход раннера новым');
      expect(root.textContent).toContain('Старый токен сначала отзовите на claude.ai');
    },
  );

  it('gives a Mac the toolchain fix as two lines, and Linux the runbook instead', async () => {
    const mac = await render({ kind: 'claude', cause: 'notExecutable' });
    expect(mac.find('wizard-check-toolchain')?.textContent).toContain('brew install --cask claude-code');
    expect(mac.find('wizard-check-setup')?.textContent).toContain('setup --only toolchain,check');
    TestBed.resetTestingModule();
    document.body.innerHTML = '';
    const linux = await render({ kind: 'claude', cause: 'notExecutable' }, { platform: 'linux' });
    expect(linux.find('wizard-check-setup')).toBeNull();
    expect(linux.root.querySelector('a')?.getAttribute('href')).toContain('#linux-one-command-634-pr-7');
  });

  it('says a runner that never picked the check up may be outdated, and links the update (review item 6)', async () => {
    const { root, find } = await render({ kind: 'offline', cause: 'notPickedUp' });
    expect(root.textContent).toContain('версия раннера, которая не умеет проходить проверку');
    expect(find('wizard-check-update')?.getAttribute('href')).toContain('#update-decision-10-rr13');
    expect(find('wizard-check-self-check')).not.toBeNull();
  });

  it('keeps one retry button: busy while in flight, gone where a retry cannot help', async () => {
    const running = await render({ kind: 'running' });
    const button = running.find('wizard-check-start');
    expect(button?.getAttribute('aria-disabled')).toBe('true');
    expect(button?.textContent).toContain('Проверяем…');
    expect(running.find('wizard-check')?.getAttribute('aria-busy')).toBe('true');

    running.fixture.componentRef.setInput('view', { kind: 'passed', version: '2.1.4' });
    await running.fixture.whenStable();
    expect(running.find('wizard-check-start')).toBe(button);
    expect(button?.getAttribute('aria-disabled')).toBeNull();
    expect(button?.textContent).toContain('Проверить снова');

    for (const kind of ['revoked', 'unsupported', 'outdated'] as const) {
      running.fixture.componentRef.setInput('view', { kind });
      await running.fixture.whenStable();
      expect(running.find('wizard-check-start'), kind).toBeNull();
    }
  });

  it('moves focus to its heading when the focused button goes away (§12.5)', async () => {
    for (const kind of ['revoked', 'unsupported', 'outdated'] as const) {
      const { fixture, find, root } = await render({ kind: 'paused' });
      const button = find('wizard-check-start');
      button?.focus();
      fixture.componentRef.setInput('view', { kind: 'starting' });
      await fixture.whenStable();
      expect(document.activeElement, kind).toBe(button);
      fixture.componentRef.setInput('view', { kind });
      // Chromium blurs a focused button as it is removed, with no relatedTarget; jsdom does not, so play it here.
      button?.dispatchEvent(new FocusEvent('blur', { relatedTarget: null }));
      button?.blur();
      await fixture.whenStable();
      expect(document.activeElement, kind).toBe(root.querySelector('h4'));
      TestBed.resetTestingModule();
      document.body.innerHTML = '';
    }
  });

  it('leaves focus alone when it had moved on from the button before it went', async () => {
    const { fixture, find, root } = await render({ kind: 'paused' });
    const button = find('wizard-check-start');
    button?.focus();
    const other = root.querySelector('h4') as HTMLElement;
    button?.dispatchEvent(new FocusEvent('blur', { relatedTarget: other }));
    button?.blur();
    fixture.componentRef.setInput('view', { kind: 'revoked' });
    await fixture.whenStable();
    expect(document.activeElement).toBe(document.body);
  });

  it('offers no button to a caller who may not start a check (a member, or after a 403)', async () => {
    const { find } = await render({ kind: 'idle' }, { canStart: false });
    expect(find('wizard-check-start')).toBeNull();
  });

  it('names why «Проверить» is unusable offline, and points at the C9 message while rate-limited', async () => {
    const offline = await render({ kind: 'idle' }, { browserOnline: false });
    const button = offline.find('wizard-check-start');
    expect(button?.getAttribute('aria-disabled')).toBe('true');
    expect(button?.textContent).toContain('Проверить');
    const reason = offline.root.querySelector(`#${button?.getAttribute('aria-describedby') ?? 'none'}`);
    expect(reason?.textContent).toContain('Нет сети');
    TestBed.resetTestingModule();
    document.body.innerHTML = '';

    const until = Date.parse('2026-11-27T14:05:00');
    const limited = await render({ kind: 'rateLimited', until }, { retryReady: false });
    const held = limited.find('wizard-check-start');
    expect(held?.getAttribute('aria-disabled')).toBe('true');
    const message = limited.root.querySelector(`#${held?.getAttribute('aria-describedby') ?? 'none'}`);
    expect(message?.textContent).toContain('Проверить снова можно в 14:05');
  });
});
