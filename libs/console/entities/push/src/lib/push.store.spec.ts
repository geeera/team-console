import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { Platform, type WebPushSupport } from '@console/shared/platform';
import type { PushDeviceDto } from '@shared/contracts';
import { deviceIdOf, PushApi } from './push.api';
import { PushDevice } from './push-device';
import { PushStore } from './push.store';

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/device-1';
const KEY = 'B'.repeat(87);

function subscriptionJson(endpoint = ENDPOINT) {
  return { endpoint, expirationTime: null, keys: { p256dh: 'BPkey', auth: 'authsecret' } };
}

function fakeSubscription(endpoint = ENDPOINT): PushSubscription {
  return { endpoint, toJSON: () => subscriptionJson(endpoint) } as unknown as PushSubscription;
}

/** The browser: a permission, a subscription, and what the prompt will answer. */
class FakeDevice {
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
      throw new DOMException('Registration failed - permission denied', 'NotAllowedError');
    }
    this.held = fakeSubscription();
    return this.held;
  });
  readonly unsubscribe = vi.fn(async () => {
    this.held = null;
  });
}

function fakeApi() {
  return {
    publicKey: vi.fn(async () => KEY),
    devices: vi.fn(async (): Promise<readonly PushDeviceDto[]> => []),
    save: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    sendTest: vi.fn(async () => ({ sent: 1, pruned: 0, failed: 0 })),
  };
}

function httpError(status: number, headers: Record<string, string> = {}): HttpErrorResponse {
  return new HttpErrorResponse({ status, headers: new HttpHeaders(headers) });
}

function setUp(support: WebPushSupport = 'ok') {
  const device = new FakeDevice();
  const api = fakeApi();
  TestBed.configureTestingModule({
    providers: [
      { provide: Platform, useValue: { info: { webPush: support } } },
      { provide: PushDevice, useValue: device },
      { provide: PushApi, useValue: api },
    ],
  });
  return { store: TestBed.inject(PushStore), device, api };
}

describe('PushStore', () => {
  describe('reading the state', () => {
    it('never asks for permission or a subscription on load or on Check again', async () => {
      const { store, device } = setUp();

      await store.refresh();
      await store.refresh();

      expect(device.subscribe).not.toHaveBeenCalled();
      expect(device.unsubscribe).not.toHaveBeenCalled();
      expect(store.view()).toBe('off');
    });

    it('starts as checking', () => {
      const { store } = setUp();
      expect(store.view()).toBe('checking');
    });

    it('reads a refused permission as blocked', async () => {
      const { store, device } = setUp();
      device.granted = 'denied';
      await store.refresh();
      expect(store.view()).toBe('denied');
    });

    it('reads a held subscription the Worker lists as on, with the date it was stored', async () => {
      const { store, device, api } = setUp();
      device.granted = 'granted';
      device.held = fakeSubscription();
      api.devices.mockResolvedValue([
        { id: await deviceIdOf(ENDPOINT), service: 'fcm.googleapis.com', userAgent: null, createdAt: '2026-10-01T09:00:00Z', lastSuccessAt: null, failures: 0 },
      ]);

      await store.refresh();

      expect(store.view()).toBe('on');
      expect(store.since()).toBe('2026-10-01T09:00:00Z');
    });

    it('reads a subscription the Worker dropped as off, and Turn on stores it again without a prompt', async () => {
      const { store, device, api } = setUp();
      device.granted = 'granted';
      device.held = fakeSubscription();

      await store.refresh();
      expect(store.view()).toBe('off');

      await store.enable();
      expect(device.subscribe).not.toHaveBeenCalled();
      expect(api.save).toHaveBeenCalledWith(subscriptionJson());
      expect(store.view()).toBe('on');
    });

    it('stays on without a date when the device list cannot be read', async () => {
      const { store, device, api } = setUp();
      device.granted = 'granted';
      device.held = fakeSubscription();
      api.devices.mockRejectedValue(httpError(0));
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await store.refresh();

      expect(store.view()).toBe('on');
      expect(store.since()).toBeNull();
    });

    it('shows why push cannot work here instead of a phase', () => {
      expect(setUp('install').store.view()).toBe('install');
    });

    it('treats a build without the service worker as a browser without push', () => {
      const device = new FakeDevice();
      device.isEnabled = false;
      TestBed.configureTestingModule({
        providers: [
          { provide: Platform, useValue: { info: { webPush: 'ok' } } },
          { provide: PushDevice, useValue: device },
          { provide: PushApi, useValue: fakeApi() },
        ],
      });
      expect(TestBed.inject(PushStore).view()).toBe('no-push');
    });
  });

  describe('turning on (from a tap)', () => {
    it('asks, subscribes with the Worker’s key and stores the subscription', async () => {
      const { store, device, api } = setUp();
      await store.refresh();

      const turningOn = store.enable();
      await vi.waitFor(() => expect(device.subscribe).toHaveBeenCalledWith(KEY));
      await turningOn;

      expect(api.save).toHaveBeenCalledWith(subscriptionJson());
      expect(store.view()).toBe('on');
      expect(store.since()).not.toBeNull();
    });

    it('shows the waiting state while the prompt is open', async () => {
      const { store, device } = setUp();
      let answer!: (value: PushSubscription) => void;
      device.subscribe.mockImplementation(() => new Promise<PushSubscription>((done) => (answer = done)));
      await store.refresh();

      const turningOn = store.enable();
      await vi.waitFor(() => expect(store.phase()).toBe('asking'));
      answer(fakeSubscription());
      await turningOn;
      expect(store.phase()).toBe('on');
    });

    it('ends blocked when the owner refuses, and off when the prompt is dismissed', async () => {
      const refused = setUp();
      refused.device.answer = 'denied';
      await refused.store.enable();
      expect(refused.store.view()).toBe('denied');
      expect(refused.store.failure()).toBeNull();

      TestBed.resetTestingModule();
      const dismissed = setUp();
      dismissed.device.answer = 'default';
      await dismissed.store.enable();
      expect(dismissed.store.view()).toBe('off');
      expect(dismissed.store.failure()).toBeNull();
    });

    it('keeps the subscription when the Worker refuses it, and Try again re-saves it without asking again', async () => {
      const { store, device, api } = setUp();
      api.save.mockRejectedValueOnce(httpError(503));

      await store.enable();
      expect(store.view()).toBe('off');
      expect(store.failure()).toBe('server');
      expect(store.hasPendingSave()).toBe(true);

      await store.enable();
      expect(device.subscribe).toHaveBeenCalledTimes(1);
      expect(api.save).toHaveBeenCalledTimes(2);
      expect(store.view()).toBe('on');
      expect(store.failure()).toBeNull();
    });

    it('says offline when the Worker cannot be reached', async () => {
      const { store, api } = setUp();
      api.publicKey.mockRejectedValue(httpError(0));
      await store.enable();
      expect(store.failure()).toBe('offline');
      expect(store.view()).toBe('off');
    });

    it('blames the browser when it fails after the permission was granted', async () => {
      const { store, device } = setUp();
      device.granted = 'granted';
      device.subscribe.mockRejectedValue(new DOMException('push service error', 'AbortError'));
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await store.enable();

      expect(store.failure()).toBe('device');
    });

    it('does nothing where push is not supported', async () => {
      const { store, device } = setUp('in-app');
      await store.enable();
      expect(device.subscribe).not.toHaveBeenCalled();
    });
  });

  describe('turning off', () => {
    it('removes the subscription on the Worker and in the browser', async () => {
      const { store, device, api } = setUp();
      await store.enable();

      await expect(store.turnOff()).resolves.toBe('off');

      expect(api.remove).toHaveBeenCalledWith(ENDPOINT);
      expect(device.unsubscribe).toHaveBeenCalled();
      expect(store.view()).toBe('off');
    });

    it('keeps both when the Worker refuses', async () => {
      const { store, device, api } = setUp();
      await store.enable();
      api.remove.mockRejectedValue(httpError(500));
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await expect(store.turnOff()).resolves.toBe('failed');

      expect(device.unsubscribe).not.toHaveBeenCalled();
      expect(store.view()).toBe('on');
    });
  });

  describe('the test notification', () => {
    it('reports how many devices it went to, in the app language', async () => {
      const { store, api } = setUp();
      api.sendTest.mockResolvedValue({ sent: 2, pruned: 0, failed: 0 });
      await store.sendTest('en');
      expect(api.sendTest).toHaveBeenCalledWith('en');
      expect(store.testOutcome()).toEqual({ kind: 'sent', devices: 2 });
    });

    it('waits as long as the Worker says after one was sent moments ago', async () => {
      const { store, api } = setUp();
      api.sendTest.mockRejectedValue(httpError(429, { 'Retry-After': '17' }));
      await store.sendTest('ru');
      expect(store.testOutcome()).toEqual({ kind: 'wait', seconds: 17 });
    });

    it('fails when the Worker errs or nothing was delivered', async () => {
      const { store, api } = setUp();
      api.sendTest.mockRejectedValueOnce(httpError(503));
      await store.sendTest('ru');
      expect(store.testOutcome()).toEqual({ kind: 'failed' });

      api.sendTest.mockResolvedValueOnce({ sent: 0, pruned: 1, failed: 0 });
      await store.sendTest('ru');
      expect(store.testOutcome()).toEqual({ kind: 'failed' });
    });
  });
});
