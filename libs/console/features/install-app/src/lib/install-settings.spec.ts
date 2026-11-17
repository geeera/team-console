import { Component, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { InstallSettings } from './install-settings';
import {
  ANDROID_CHROME,
  configureInstall,
  IPHONE_CHROME,
  IPHONE_SAFARI,
  IPHONE_TELEGRAM,
  MAC_FIREFOX,
  MAC_SAFARI,
  MAC_SAFARI_16,
  settle,
  type InstallWorld,
} from './testing.spec-helpers';
import type { PlatformSignals } from '@console/shared/platform';

@Component({
  imports: [InstallSettings],
  template: `<h2 id="app-h">App</h2>
    <tc-install-settings labelledBy="app-h" (focusLost)="focusLost()" />`,
})
class Host {
  readonly settings = viewChild.required(InstallSettings);
  readonly focusLost = vi.fn();
}

describe('InstallSettings', () => {
  let root: HTMLElement;
  let host: Host;

  beforeEach(() => localStorage.clear());
  afterEach(() => root?.remove());

  async function render(
    userAgent: string,
    overrides: Partial<PlatformSignals> = {},
    before?: (world: InstallWorld) => void,
  ): Promise<InstallWorld> {
    const world = await configureInstall(userAgent, overrides);
    before?.(world);
    const fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    root = fixture.nativeElement as HTMLElement;
    document.body.appendChild(root);
    await settle();
    return world;
  }

  const byTestId = (id: string): HTMLElement | null => root.querySelector(`[data-testid="${id}"]`);
  const sub = (): string => byTestId('install-entry-sub')?.textContent?.trim() ?? '';
  const chip = (): string | null => byTestId('install-entry-chip')?.textContent?.trim() ?? null;

  it('says installed inside the installed app, with no action', async () => {
    await render(IPHONE_SAFARI, { navigatorStandalone: true });

    expect(byTestId('install-entry')?.textContent).toContain('Установлено на это устройство');
    expect(sub()).toBe('Вы в приложении Team Console.');
    expect(chip()).toBe('Установлено');
    expect(root.querySelector('button')).toBeNull();
  });

  it('installs with one tap where Chromium kept its event, and says so after', async () => {
    await render(ANDROID_CHROME, {}, (w) => w.fireEvent('accepted'));
    expect(sub()).toBe('Своё окно и значок — без вкладок браузера.');
    expect(chip()).toBe('Не установлено');

    byTestId('install-settings-install')?.click();
    await settle();

    expect(sub()).toBe('Откройте Team Console со значка.');
    expect(chip()).toBe('Установлено');
    expect(host.focusLost).toHaveBeenCalledOnce();
  });

  it('shows the alert and keeps Install when the dialog cannot open', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await render(ANDROID_CHROME, {}, (w) => w.fireEvent('accepted', true));
    byTestId('install-settings-install')?.click();
    await settle();

    expect(byTestId('install-settings-error')?.getAttribute('role')).toBe('alert');
    expect(byTestId('install-settings-install')).not.toBeNull();
    warn.mockRestore();
  });

  it('points Chromium without the event to the browser menu', async () => {
    await render(ANDROID_CHROME);

    expect(sub()).toContain('из меню браузера');
    expect(chip()).toBeNull();
    expect(root.querySelector('button')).toBeNull();
  });

  it('opens the Home Screen steps on iPhone, from its toggle or from the page', async () => {
    await render(IPHONE_SAFARI);
    expect(sub()).toContain('без этого iPhone не присылает уведомления');
    expect(byTestId('push-install-guide')).toBeNull();

    host.settings().openGuide();
    await settle();

    expect(byTestId('install-settings-how')?.getAttribute('aria-expanded')).toBe('true');
    expect(byTestId('push-install-guide')?.querySelectorAll('li')).toHaveLength(3);
  });

  it('uses the other-browser first step in Chrome on iPhone', async () => {
    await render(IPHONE_CHROME);
    byTestId('install-settings-how')?.click();
    await settle();

    expect(byTestId('guide-step-other')).not.toBeNull();
  });

  it('offers to copy the link in another app’s web view', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await render(IPHONE_TELEGRAM);
    expect(sub()).toContain('Откройте эту страницу в Safari');

    byTestId('install-settings-copy')?.click();
    await settle();

    expect(writeText).toHaveBeenCalledWith(`${location.origin}/`);
    expect(byTestId('install-settings-copy')?.textContent).toContain('Скопировано');
  });

  it.each([
    ['macOS Safari 17+', MAC_SAFARI, 'В Safari выберите Файл → «Добавить в Dock…».'],
    ['macOS Safari 16', MAC_SAFARI_16, 'Добавить в Dock можно в Safari 17 и новее (macOS Sonoma).'],
    ['Firefox', MAC_FIREFOX, 'Этот браузер не устанавливает веб‑приложения. Откройте консоль в Chrome, Edge или Safari.'],
  ])('gives %s its hint and no action', async (_name, agent, text) => {
    await render(agent, { maxTouchPoints: 0 });

    expect(sub()).toBe(text);
    expect(chip()).toBeNull();
    expect(root.querySelector('button')).toBeNull();
  });
});
