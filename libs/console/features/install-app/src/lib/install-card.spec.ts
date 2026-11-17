import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Toaster } from '@console/shared/ui';
import { InstallCard } from './install-card';
import { INSTALL_PROMPT_KEY } from './install-memory';
import {
  ANDROID_CHROME,
  configureInstall,
  IPHONE_CHROME,
  IPHONE_SAFARI,
  MAC_SAFARI,
  settle,
  type InstallWorld,
} from './testing.spec-helpers';

@Component({
  imports: [InstallCard],
  template: `<tc-install-card [ready]="ready()" (dismissed)="dismissed()" />`,
})
class Host {
  readonly ready = signal(true);
  readonly dismissed = vi.fn();
}

describe('InstallCard', () => {
  let root: HTMLElement;
  let host: Host;

  beforeEach(() => localStorage.clear());
  afterEach(() => root?.remove());

  async function render(
    userAgent: string,
    before?: (world: InstallWorld) => void,
    maxTouchPoints = 5,
  ): Promise<InstallWorld> {
    const world = await configureInstall(userAgent, { maxTouchPoints });
    before?.(world);
    await world.router.navigateByUrl('/needs-you');
    const fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    root = fixture.nativeElement as HTMLElement;
    document.body.appendChild(root);
    await settle();
    return world;
  }

  const byTestId = (id: string): HTMLElement | null => root.querySelector(`[data-testid="${id}"]`);
  const click = async (id: string): Promise<void> => {
    byTestId(id)?.click();
    await settle();
  };

  it('offers one tap with a kept install event, named for this device', async () => {
    await render(ANDROID_CHROME, (world) => world.fireEvent());
    const card = byTestId('install-card');

    expect(card?.tagName).toBe('ASIDE');
    expect(card?.querySelector('h2')?.textContent?.trim()).toBe('Установите Team Console');
    expect(card?.getAttribute('aria-labelledby')).toBe(card?.querySelector('h2')?.id);
    expect(byTestId('install-card-install')?.getAttribute('aria-label')).toBe(
      'Установить Team Console на это устройство',
    );
    expect(byTestId('install-card-later')?.textContent?.trim()).toBe('Не сейчас');
    expect(byTestId('install-card-never')?.textContent?.trim()).toBe('Больше не показывать');
  });

  it('waits for the screen to be ready', async () => {
    const world = await configureInstall(IPHONE_SAFARI);
    await world.router.navigateByUrl('/needs-you');
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.ready.set(false);
    root = fixture.nativeElement as HTMLElement;
    await settle();
    expect(byTestId('install-card')).toBeNull();

    fixture.componentInstance.ready.set(true);
    await settle();
    expect(byTestId('install-card')).not.toBeNull();
  });

  it('turns into the success line with focus on it when the dialog is accepted', async () => {
    let event: ReturnType<InstallWorld['fireEvent']> | undefined;
    await render(ANDROID_CHROME, (world) => {
      event = world.fireEvent('accepted');
    });
    await click('install-card-install');

    expect(event?.prompt).toHaveBeenCalledOnce();
    const done = byTestId('install-card-done');
    expect(done?.getAttribute('role')).toBe('status');
    expect(done?.textContent).toContain('Team Console установлено');
    expect(document.activeElement).toBe(done);
    expect(localStorage.getItem(INSTALL_PROMPT_KEY)).toBeNull();

    await click('install-card-done-close');
    expect(byTestId('install-card-done')).toBeNull();
    expect(host.dismissed).toHaveBeenCalledOnce();
  });

  it('snoozes for 14 days with the toast when the dialog is dismissed', async () => {
    await render(ANDROID_CHROME, (world) => world.fireEvent('dismissed'));
    const toast = vi.spyOn(TestBed.inject(Toaster), 'show');
    await click('install-card-install');

    expect(byTestId('install-card')).toBeNull();
    expect(toast).toHaveBeenCalledWith('Установить можно в Настройках → Приложение');
    expect(JSON.parse(localStorage.getItem(INSTALL_PROMPT_KEY) ?? '')).toMatchObject({ choice: 'snoozed' });
    expect(host.dismissed).toHaveBeenCalledOnce();
  });

  it('keeps the card with an alert and the menu fallback when the dialog cannot open', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await render(ANDROID_CHROME, (world) => world.fireEvent('accepted', true));
    await click('install-card-install');

    expect(byTestId('install-card')).not.toBeNull();
    expect(byTestId('install-card-error')?.getAttribute('role')).toBe('alert');
    expect(byTestId('install-card-error')?.textContent).toContain('из меню браузера');
    warn.mockRestore();
  });

  it('opens the Home Screen steps inside the card on iPhone Safari', async () => {
    await render(IPHONE_SAFARI);
    const how = byTestId('install-card-how');
    expect(how?.getAttribute('aria-expanded')).toBe('false');
    expect(byTestId('install-card')?.textContent).toContain('На iPhone это делается в Safari');

    await click('install-card-how');

    expect(how?.getAttribute('aria-expanded')).toBe('true');
    const guide = byTestId('push-install-guide');
    expect(guide?.id).toBe(how?.getAttribute('aria-controls'));
    expect(guide?.querySelectorAll('li')).toHaveLength(3);
    expect(guide?.textContent).toContain('Откройте Team Console со значка на экране «Домой».');
    expect(how?.textContent).toContain('Скрыть шаги');
  });

  it('tells Chrome on iPhone to use its own Share button', async () => {
    await render(IPHONE_CHROME);
    expect(byTestId('install-card')?.textContent).toContain('Полминуты прямо из этого браузера');

    await click('install-card-how');

    expect(byTestId('guide-step-other')?.textContent).toContain('в адресной строке браузера');
  });

  it('is one line with no install button in Safari on the Mac', async () => {
    await render(MAC_SAFARI, undefined, 0);

    expect(byTestId('install-card')?.textContent).toContain('Добавить в Dock');
    expect(byTestId('install-card-install')).toBeNull();
    expect(byTestId('install-card-how')).toBeNull();
  });

  it('waits for the next screen when Chromium’s event comes after the screen rendered', async () => {
    const world = await render(ANDROID_CHROME);
    world.fireEvent();
    await settle();
    expect(byTestId('install-card')).toBeNull();

    await world.router.navigateByUrl('/p/storify/board');
    await settle();
    expect(byTestId('install-card')).not.toBeNull();
  });

  it('never shows again after Don’t show again', async () => {
    await render(IPHONE_SAFARI);
    await click('install-card-never');

    expect(byTestId('install-card')).toBeNull();
    expect(localStorage.getItem(INSTALL_PROMPT_KEY)).toBe('{"choice":"never"}');
    expect(host.dismissed).toHaveBeenCalledOnce();
  });
});
