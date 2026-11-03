import { TestBed } from '@angular/core/testing';
import { deviceIdOf } from '@console/entities/push';
import { Toaster } from '@console/shared/ui';
import { PushSettingsCard } from './push-settings-card';
import {
  configurePush,
  DESKTOP,
  ENDPOINT,
  fakeSubscription,
  httpError,
  IPHONE_APP,
  KEY,
  settle,
  type PushWorld,
} from './testing.spec-helpers';
import type { PlatformInfo } from '@console/shared/platform';

describe('PushSettingsCard', () => {
  let root: HTMLElement;

  async function render(platform: PlatformInfo = DESKTOP, before?: (world: PushWorld) => void): Promise<PushWorld> {
    const world = await configurePush(platform);
    before?.(world);
    const fixture = TestBed.createComponent(PushSettingsCard);
    root = fixture.nativeElement as HTMLElement;
    document.body.appendChild(root);
    await settle();
    return world;
  }

  const byTestId = (id: string): HTMLElement | null => root.querySelector(`[data-testid="${id}"]`);
  const click = async (id: string): Promise<void> => {
    (byTestId(id) as HTMLButtonElement).click();
    await settle();
  };

  afterEach(() => root?.remove());

  it('asks for nothing on load: no permission prompt, no subscription', async () => {
    const { device } = await render();

    expect(byTestId('push-off')).not.toBeNull();
    expect(device.subscribe).not.toHaveBeenCalled();
    expect(byTestId('push-off')?.textContent).toContain('Браузер спросит разрешение');
  });

  it('turns on from the button’s tap: prompt, subscribe, save, then "on" with focus on its title', async () => {
    const { device, api } = await render();

    await click('push-enable');

    expect(device.subscribe).toHaveBeenCalledWith(KEY);
    expect(api.save).toHaveBeenCalledOnce();
    const on = byTestId('push-on');
    expect(on?.textContent).toContain('Уведомления на этом устройстве включены');
    expect(document.activeElement).toBe(on?.querySelector('h3'));
  });

  it('shows the Home Screen guide instead of the button in iPhone Safari', async () => {
    const { device } = await render({ ...IPHONE_APP, isStandalone: false, webPush: 'install' });

    expect(byTestId('push-enable')).toBeNull();
    const steps = byTestId('push-install-guide')?.querySelectorAll('li') ?? [];
    expect(steps).toHaveLength(3);
    expect(steps[0]?.textContent).toContain('В Safari нажмите');
    expect(steps[0]?.textContent).toContain('Ещё');
    expect(steps[1]?.textContent).toContain('На экран „Домой“');
    expect(device.permission).not.toHaveBeenCalled();
  });

  it.each([
    ['old-ios', 'iOS 16.4'],
    ['in-app', 'внутри другого приложения'],
    ['no-push', 'не умеет веб-уведомления'],
  ] as const)('explains why push cannot work here: %s', async (webPush, text) => {
    await render({ ...DESKTOP, webPush });
    expect(byTestId('push-unsupported')?.textContent).toContain(text);
  });

  it.each([
    [IPHONE_APP, 'Настройки iPhone → Уведомления → Team Console'],
    [{ ...DESKTOP, settingsHost: 'safari' as const }, `для ${location.host} выберите`],
    [DESKTOP, 'Нажмите значок слева от адреса'],
  ])('says where to allow it again when blocked', async (platform, text) => {
    await render(platform, ({ device }) => (device.granted = 'denied'));
    expect(byTestId('push-denied-path')?.textContent).toContain(text);
  });

  it('Check again only re-reads the state; it never subscribes', async () => {
    const { device } = await render(DESKTOP, (world) => (world.device.granted = 'denied'));

    device.granted = 'default';
    await click('push-recheck');

    expect(byTestId('push-off')).not.toBeNull();
    expect(device.subscribe).not.toHaveBeenCalled();
  });

  it('keeps the subscription when the server refuses, and Try again saves it without asking again', async () => {
    const { device, api } = await render(DESKTOP, (world) => world.api.save.mockRejectedValueOnce(httpError(503)));

    await click('push-enable');
    expect(byTestId('push-failure')?.textContent).toContain('Сервер не принял это устройство');
    expect(byTestId('push-enable')?.textContent).toContain('Попробовать ещё раз');

    await click('push-enable');
    expect(device.subscribe).toHaveBeenCalledTimes(1);
    expect(api.save).toHaveBeenCalledTimes(2);
    expect(byTestId('push-on')).not.toBeNull();
  });

  describe('on', () => {
    async function renderOn(platform: PlatformInfo = DESKTOP): Promise<PushWorld> {
      const id = await deviceIdOf(ENDPOINT);
      return render(platform, ({ device, api }) => {
        device.granted = 'granted';
        device.held = fakeSubscription();
        api.devices.mockResolvedValue([
          { id, service: 'web.push.apple.com', userAgent: null, createdAt: '2026-10-01T09:00:00Z', lastSuccessAt: null, failures: 0 },
        ]);
      });
    }

    it('shows since when, and the badge line on iPhone only', async () => {
      await renderOn(IPHONE_APP);
      expect(byTestId('push-on')?.textContent).toContain('С 1 октября');
      expect(byTestId('push-badge-line')?.textContent).toContain('сейчас 3');

      TestBed.resetTestingModule();
      root.remove();
      await renderOn(DESKTOP);
      expect(byTestId('push-badge-line')).toBeNull();
    });

    it('sends a test in the app language and reports where it went', async () => {
      const { api } = await renderOn();
      api.sendTest.mockResolvedValue({ sent: 2, pruned: 0, failed: 0 });

      await click('push-test');

      expect(api.sendTest).toHaveBeenCalledWith('ru');
      expect(byTestId('push-test-sent')?.textContent).toContain('На 2 устройства');
    });

    it('says when the next test is allowed after the 30 s limit', async () => {
      const { api } = await renderOn();
      api.sendTest.mockRejectedValue(httpError(429, { 'Retry-After': '21' }));

      await click('push-test');

      expect(byTestId('push-test-wait')?.textContent).toContain('Попробуйте через 21 с');
    });

    it('turns off on the server and in the browser, then offers Turn on again', async () => {
      const { api, device } = await renderOn();
      const toast = vi.spyOn(TestBed.inject(Toaster), 'show');

      await click('push-turn-off');

      expect(api.remove).toHaveBeenCalledWith(ENDPOINT);
      expect(device.unsubscribe).toHaveBeenCalled();
      expect(toast).toHaveBeenCalledWith('Уведомления на этом устройстве выключены');
      expect(document.activeElement).toBe(byTestId('push-enable'));
    });

    it('keeps the test and Turn off from acting while offline and says why', async () => {
      const { api, online } = await renderOn();
      online.set(false);
      await settle();

      const test = byTestId('push-test') as HTMLButtonElement;
      expect(test.getAttribute('aria-disabled')).toBe('true');
      expect(test.getAttribute('aria-describedby')).toMatch(/^tc-push-offline-/);
      await click('push-test');
      await click('push-turn-off');
      expect(api.sendTest).not.toHaveBeenCalled();
      expect(api.remove).not.toHaveBeenCalled();
    });
  });
});
