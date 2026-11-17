import { TestBed } from '@angular/core/testing';
import {
  INSTALL_PROMPT_CAPTURE,
  InstallPrompt,
  InstallPromptCapture,
  type BeforeInstallPromptEvent,
} from './install-prompt';
import { Platform, type PlatformSignals } from './platform';

const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';

function fakeEvent(
  outcome: 'accepted' | 'dismissed',
  prompt: () => Promise<unknown> = async () => undefined,
): BeforeInstallPromptEvent {
  const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
    prompt: () => Promise<unknown>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
  };
  event.prompt = vi.fn(prompt);
  event.userChoice = Promise.resolve({ outcome });
  return event;
}

function setup() {
  const target = new EventTarget();
  const capture = new InstallPromptCapture(target as unknown as Window);
  const signals: PlatformSignals = {
    userAgent: ANDROID_CHROME,
    maxTouchPoints: 5,
    navigatorStandalone: undefined,
    displayModeStandalone: false,
    hasServiceWorker: true,
    hasPushManager: true,
    hasNotification: true,
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: INSTALL_PROMPT_CAPTURE, useValue: capture },
      { provide: Platform, useValue: { signals } },
    ],
  });
  return { target, capture, prompt: TestBed.inject(InstallPrompt) };
}

describe('InstallPromptCapture', () => {
  it('keeps the event and stops Chrome’s own infobar', () => {
    const { target, capture } = setup();
    const event = fakeEvent('accepted');
    target.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(capture.event).toBe(event);
  });

  it('ignores an event that is not an install prompt', () => {
    const { target, capture } = setup();
    target.dispatchEvent(new Event('beforeinstallprompt', { cancelable: true }));

    expect(capture.event).toBeNull();
  });
});

describe('InstallPrompt', () => {
  it('follows an event that arrives after the app started', () => {
    const { target, prompt } = setup();
    expect(prompt.path()).toBe('menu');

    target.dispatchEvent(fakeEvent('accepted'));

    expect(prompt.path()).toBe('native');
  });

  it('reports an accepted install and marks the launch installed', async () => {
    const { target, prompt } = setup();
    target.dispatchEvent(fakeEvent('accepted'));

    await expect(prompt.prompt()).resolves.toBe('accepted');
    expect(prompt.installedNow()).toBe(true);
    expect(prompt.path()).toBe('installed');
    expect(prompt.isPrompting()).toBe(false);
  });

  it('spends the event when the dialog is dismissed', async () => {
    const { target, prompt } = setup();
    target.dispatchEvent(fakeEvent('dismissed'));

    await expect(prompt.prompt()).resolves.toBe('dismissed');
    expect(prompt.hasEvent()).toBe(false);
    expect(prompt.path()).toBe('menu');
  });

  it('keeps the event when the dialog fails to open', async () => {
    const { target, prompt } = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    target.dispatchEvent(
      fakeEvent('accepted', async () => {
        throw new DOMException('not allowed', 'NotAllowedError');
      }),
    );

    await expect(prompt.prompt()).resolves.toBe('failed');
    expect(prompt.hasEvent()).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('fails without a kept event', async () => {
    const { prompt } = setup();

    await expect(prompt.prompt()).resolves.toBe('failed');
  });

  it('says installed when the browser reports it', () => {
    const { target, prompt } = setup();
    target.dispatchEvent(fakeEvent('accepted'));
    target.dispatchEvent(new Event('appinstalled'));

    expect(prompt.installedNow()).toBe(true);
    expect(prompt.hasEvent()).toBe(false);
  });
});
