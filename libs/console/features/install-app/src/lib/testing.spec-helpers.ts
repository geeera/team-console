import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationInitStatus, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { AccessSession } from '@console/shared/api';
import { provideConsoleI18n } from '@console/shared/i18n';
import {
  INSTALL_PROMPT_CAPTURE,
  InstallPromptCapture,
  Platform,
  type BeforeInstallPromptEvent,
  type PlatformSignals,
} from '@console/shared/platform';

export const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
export const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
export const IPHONE_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1';
export const IPHONE_TELEGRAM =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari/604.1 Telegram/11.0';
export const MAC_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15';
export const MAC_SAFARI_16 =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15';
export const MAC_FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:144.0) Gecko/20100101 Firefox/144.0';

@Component({ template: '' })
class Blank {}

export interface InstallWorld {
  readonly router: Router;
  readonly expired: ReturnType<typeof signal<boolean>>;
  /** Chromium fires its install event; `prompt()` answers `outcome`, or throws with `fails`. */
  fireEvent(outcome?: 'accepted' | 'dismissed', fails?: boolean): BeforeInstallPromptEvent;
  fireInstalled(): void;
}

export async function configureInstall(
  userAgent: string,
  overrides: Partial<PlatformSignals> = {},
): Promise<InstallWorld> {
  const target = new EventTarget();
  const capture = new InstallPromptCapture(target as unknown as Window);
  const signals: PlatformSignals = {
    userAgent,
    maxTouchPoints: 5,
    navigatorStandalone: undefined,
    displayModeStandalone: false,
    hasServiceWorker: true,
    hasPushManager: true,
    hasNotification: true,
    ...overrides,
  };
  const expired = signal(false);
  TestBed.configureTestingModule({
    providers: [
      provideConsoleI18n(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([
        { path: 'needs-you', component: Blank },
        { path: 'settings', component: Blank },
        { path: 'p/:slug/:section', component: Blank },
      ]),
      { provide: INSTALL_PROMPT_CAPTURE, useValue: capture },
      { provide: Platform, useValue: { signals } },
      { provide: AccessSession, useValue: { expired } },
    ],
  });
  await TestBed.inject(ApplicationInitStatus).donePromise;
  return {
    router: TestBed.inject(Router),
    expired,
    fireEvent(outcome = 'accepted', fails = false) {
      const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
        prompt: () => Promise<unknown>;
        userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
      };
      event.prompt = vi.fn(async () => {
        if (fails) {
          throw new DOMException('not allowed', 'NotAllowedError');
        }
      });
      event.userChoice = Promise.resolve({ outcome });
      target.dispatchEvent(event);
      return event;
    },
    fireInstalled() {
      target.dispatchEvent(new Event('appinstalled'));
    },
  };
}

export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    TestBed.tick();
  }
}
