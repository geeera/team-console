import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { Toaster } from '@console/shared/ui';
import { FOCUS_PUSH_SETTINGS_STATE, PUSH_NUDGE_KEY } from './nudge-memory';
import { PushNudge } from './push-nudge';
import { configurePush, DESKTOP, fakeSubscription, IPHONE_APP, settle, type PushWorld } from './testing.spec-helpers';
import type { PlatformInfo } from '@console/shared/platform';

describe('PushNudge', () => {
  let root: HTMLElement;
  let nudge: PushNudge;

  async function render(platform: PlatformInfo = DESKTOP, before?: (world: PushWorld) => void): Promise<PushWorld> {
    const world = await configurePush(platform);
    before?.(world);
    const fixture = TestBed.createComponent(PushNudge);
    nudge = fixture.componentInstance;
    root = fixture.nativeElement as HTMLElement;
    document.body.appendChild(root);
    await settle();
    return world;
  }

  const byTestId = (id: string): HTMLElement | null => root.querySelector(`[data-testid="${id}"]`);

  beforeEach(() => localStorage.removeItem(PUSH_NUDGE_KEY));
  afterEach(() => root?.remove());

  it('says in one line that notifications are off, with Turn on and a labelled close button', async () => {
    const { device } = await render();

    const text = root.querySelector('.push-nudge__text');
    expect(text?.textContent).toBe('Уведомления выключены');
    expect(byTestId('push-nudge')?.getAttribute('aria-labelledby')).toBe(text?.id);
    expect(byTestId('push-nudge-enable')?.textContent).toContain('Включить');
    expect(byTestId('push-nudge-later')?.getAttribute('aria-label')).toBe('Скрыть подсказку про уведомления');
    expect(root.querySelectorAll('.push-nudge p')).toHaveLength(1);
    expect(device.subscribe).not.toHaveBeenCalled();
  });

  it('turns on from its own tap and then says so', async () => {
    const { device } = await render();

    byTestId('push-nudge-enable')?.click();
    await settle();

    expect(device.subscribe).toHaveBeenCalledOnce();
    expect(byTestId('push-nudge-on')?.textContent).toContain('Уведомления включены');
  });

  it('hides on close, remembers it on this device and hands focus back', async () => {
    await render();
    const dismissed = vi.fn();
    nudge.dismissed.subscribe(dismissed);
    const toast = vi.spyOn(TestBed.inject(Toaster), 'show');

    byTestId('push-nudge-later')?.click();
    await settle();

    expect(byTestId('push-nudge')).toBeNull();
    expect(localStorage.getItem(PUSH_NUDGE_KEY)).toBe('dismissed');
    expect(dismissed).toHaveBeenCalledOnce();
    expect(toast).toHaveBeenCalledWith('Включить можно в Настройках → Уведомления');
  });

  it('stays hidden on a device where it was closed before', async () => {
    localStorage.setItem(PUSH_NUDGE_KEY, 'dismissed');
    await render();
    expect(byTestId('push-nudge')).toBeNull();
  });

  it('stays hidden while push is on', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await render(DESKTOP, ({ device, api }) => {
      device.granted = 'granted';
      device.held = fakeSubscription();
      api.devices.mockRejectedValue(new Error('not needed'));
    });
    expect(byTestId('push-nudge')).toBeNull();
  });

  it('leads iPhone Safari to the Home Screen guide in Settings', async () => {
    await render({ ...IPHONE_APP, isStandalone: false, webPush: 'install' });
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

    expect(byTestId('push-nudge-enable')).toBeNull();
    byTestId('push-nudge-how')?.click();
    await settle();

    expect(navigate).toHaveBeenCalledWith(['/settings'], { state: { [FOCUS_PUSH_SETTINGS_STATE]: true } });
  });
});
