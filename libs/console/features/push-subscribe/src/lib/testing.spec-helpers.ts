import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { ApplicationInitStatus, signal, type Provider, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { NeedsYouCounts } from '@console/entities/project';
import { PushApi, PushDevice } from '@console/entities/push';
import { NetworkStatus } from '@console/shared/api';
import { provideConsoleI18n } from '@console/shared/i18n';
import { Platform, type PlatformInfo } from '@console/shared/platform';
import type { PushDeviceDto } from '@shared/contracts';

export const ENDPOINT = 'https://web.push.apple.com/device-1';
export const KEY = 'B'.repeat(87);

export function fakeSubscription(endpoint = ENDPOINT): PushSubscription {
  const json = { endpoint, expirationTime: null, keys: { p256dh: 'BPkey', auth: 'authsecret' } };
  return { endpoint, toJSON: () => json } as unknown as PushSubscription;
}

/** The browser's side: a permission, the subscription it holds, and what its prompt answers. */
export class FakeDevice {
  isEnabled = true;
  granted: NotificationPermission = 'default';
  answer: NotificationPermission = 'granted';
  held: PushSubscription | null = null;

  readonly permission = vi.fn(() => this.granted);
  readonly current = vi.fn(async () => this.held);
  readonly subscribe = vi.fn(async (_key: string) => {
    if (this.granted === 'default') {
      this.granted = this.answer;
    }
    if (this.granted !== 'granted') {
      throw new DOMException('permission denied', 'NotAllowedError');
    }
    this.held = fakeSubscription();
    return this.held;
  });
  readonly unsubscribe = vi.fn(async () => {
    this.held = null;
  });
}

export function fakeApi() {
  return {
    publicKey: vi.fn(async () => KEY),
    devices: vi.fn(async (): Promise<readonly PushDeviceDto[]> => []),
    save: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    sendTest: vi.fn(async () => ({ sent: 1, pruned: 0, failed: 0 })),
  };
}

export function httpError(status: number, headers: Record<string, string> = {}): HttpErrorResponse {
  return new HttpErrorResponse({ status, headers: new HttpHeaders(headers) });
}

export const DESKTOP: PlatformInfo = {
  isIos: false,
  iosVersion: null,
  isStandalone: false,
  isInAppBrowser: false,
  settingsHost: 'other',
  webPush: 'ok',
};

export const IPHONE_APP: PlatformInfo = {
  ...DESKTOP,
  isIos: true,
  iosVersion: [26, 0],
  isStandalone: true,
  settingsHost: 'ios',
};

export interface PushWorld {
  readonly device: FakeDevice;
  readonly api: ReturnType<typeof fakeApi>;
  readonly online: WritableSignal<boolean>;
}

export async function configurePush(platform: PlatformInfo, extra: Provider[] = []): Promise<PushWorld> {
  const device = new FakeDevice();
  const api = fakeApi();
  const online = signal(true);
  TestBed.configureTestingModule({
    providers: [
      provideConsoleI18n(),
      provideRouter([]),
      { provide: Platform, useValue: { info: platform } },
      { provide: PushDevice, useValue: device },
      { provide: PushApi, useValue: api },
      { provide: NetworkStatus, useValue: { online } },
      { provide: NeedsYouCounts, useValue: { total: signal(3) } },
      ...extra,
    ],
  });
  await TestBed.inject(ApplicationInitStatus).donePromise;
  return { device, api, online };
}

export async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    TestBed.tick();
  }
}
