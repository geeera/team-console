import { expect, type BrowserContext, type Page } from '@playwright/test';
import type { PushSubscriptionRequest } from '@shared/contracts';
import { apiClient, type Stack } from './stack';

/**
 * Web push in the test browser (#174, #249). The suite blocks service workers, and a real `PushManager.subscribe`
 * would call Google's or Apple's push service, so `emulatePush` stands in for the browser's side only: a worker that
 * controls the page, its registration's `pushManager`, and `Notification.permission`. The subscription it hands out
 * is a device of the local stack's fake push service (`apps/api/fake-push`), whose keys stay there: what the api
 * sends is really encrypted, delivered and decrypted, and no request ever leaves the machine.
 */

/** Where the emulated browser starts: the permission and whether it already holds the subscription. */
export interface PushStart {
  readonly permission: NotificationPermission;
  readonly isSubscribed: boolean;
}

/** What the page did with the emulated APIs, read back from the page. */
export interface PushRecord {
  readonly permission: NotificationPermission;
  readonly isSubscribed: boolean;
  /** Times the permission prompt would have shown: `requestPermission()`, or `subscribe()` while undecided. */
  readonly prompts: number;
  /** The `applicationServerKey` of the last `subscribe()`, base64url; `null` before one. */
  readonly serverKey: string | null;
}

/** One delivery the fake push service took, decrypted (`FakeDelivery` of `@worker/push/testing`). */
export interface FakeDelivery {
  readonly endpoint: string;
  readonly outcome: string;
  readonly payload: unknown;
  readonly decryptError: string | null;
}

/** How the fake push service answers the next deliveries to a device (`FakePushOutcome`). */
export type FakePushOutcome = 'ok' | 'not-found' | 'gone' | 'rate-limited' | 'unavailable';

/** The emulation's state in the tab's sessionStorage, so a reload or a new route keeps it. */
const STATE_KEY = 'tc.e2e.push';
const PUSH_SUBSCRIPTIONS = '/api/v1/push/subscriptions';

function fakePushOf(stack: Stack): string {
  if (stack.fakePushURL === null) {
    throw new Error('This step needs the fake push service (a local stack)');
  }
  return stack.fakePushURL;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSubscription(value: unknown): value is PushSubscriptionRequest {
  return (
    isRecord(value) &&
    typeof value['endpoint'] === 'string' &&
    isRecord(value['keys']) &&
    typeof value['keys']['p256dh'] === 'string' &&
    typeof value['keys']['auth'] === 'string'
  );
}

function isDelivery(value: unknown): value is FakeDelivery {
  return isRecord(value) && typeof value['endpoint'] === 'string' && typeof value['outcome'] === 'string';
}

async function fakePushPost(stack: Stack, path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${fakePushOf(stack)}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`fake push ${path}: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

/** A new device on the fake push service (an FCM endpoint, as Chrome's), as `PushSubscription.toJSON()` returns it. */
export async function fakePushDevice(stack: Stack): Promise<PushSubscriptionRequest> {
  const subscription = await fakePushPost(stack, '/_fake/subscriptions', { host: 'fcm.googleapis.com' });
  if (!isSubscription(subscription)) {
    throw new Error(`fake push returned no subscription: ${JSON.stringify(subscription)}`);
  }
  return subscription;
}

/** Queues how the next deliveries to `endpoint` end (one each, in order). */
export async function fakePushNext(
  stack: Stack,
  endpoint: string,
  outcomes: readonly FakePushOutcome[],
): Promise<void> {
  await fakePushPost(stack, '/_fake/next', { endpoint, outcomes });
}

/** Every delivery the fake push service took for `endpoint`, decrypted, oldest first. */
export async function fakePushDeliveries(stack: Stack, endpoint: string): Promise<FakeDelivery[]> {
  const response = await fetch(`${fakePushOf(stack)}/_fake/state`);
  if (!response.ok) {
    throw new Error(`fake push state: ${response.status}`);
  }
  const state: unknown = await response.json();
  const deliveries = isRecord(state) ? state['deliveries'] : undefined;
  if (!Array.isArray(deliveries) || !deliveries.every(isDelivery)) {
    throw new Error(`fake push state has no deliveries list: ${JSON.stringify(state)}`);
  }
  return deliveries.filter((delivery) => delivery.endpoint === endpoint);
}

/**
 * Makes every page of `context` a browser with web push: an Angular worker controls it (answering update checks with
 * "no new version"), its registration's `pushManager` holds `subscription` once subscribed, and the permission starts
 * at `start.permission`. `subscribe()` while undecided counts as one prompt the owner accepts. On the iPhone project
 * the page also runs as the installed Home Screen app, the only place iOS has web push.
 */
export async function emulatePush(
  context: BrowserContext,
  subscription: PushSubscriptionRequest,
  start: PushStart,
): Promise<void> {
  await context.addInitScript(
    ({ subscription, start, stateKey }) => {
      // The app's own document only, as the install-prompt memory of fixtures.ts.
      if (window !== window.top || window.location.origin === 'null') {
        return;
      }
      interface State {
        permission: NotificationPermission;
        isSubscribed: boolean;
        prompts: number;
        serverKey: string | null;
      }
      const read = (): State => {
        const stored = sessionStorage.getItem(stateKey);
        return stored === null
          ? { permission: start.permission, isSubscribed: start.isSubscribed, prompts: 0, serverKey: null }
          : (JSON.parse(stored) as State);
      };
      const write = (change: Partial<State>): void => {
        sessionStorage.setItem(stateKey, JSON.stringify({ ...read(), ...change }));
      };
      write({});

      if (/\biPhone\b/.test(navigator.userAgent)) {
        Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true, configurable: true });
      }

      Object.defineProperty(Notification, 'permission', { get: () => read().permission, configurable: true });
      Notification.requestPermission = async () => {
        const state = read();
        if (state.permission === 'default') {
          write({ permission: 'granted', prompts: state.prompts + 1 });
        }
        return read().permission;
      };

      const base64url = (bytes: Uint8Array): string =>
        btoa(String.fromCharCode(...bytes))
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '');
      const pushSubscription = (): PushSubscription =>
        ({
          endpoint: subscription.endpoint,
          expirationTime: null,
          options: { userVisibleOnly: true, applicationServerKey: null },
          getKey: () => null,
          toJSON: () => ({
            endpoint: subscription.endpoint,
            expirationTime: null,
            keys: { ...subscription.keys },
          }),
          unsubscribe: async () => {
            write({ isSubscribed: false });
            return true;
          },
        }) as unknown as PushSubscription;
      const pushManager = {
        getSubscription: async () => (read().isSubscribed ? pushSubscription() : null),
        permissionState: async () => (read().permission === 'default' ? 'prompt' : read().permission),
        subscribe: async (options: PushSubscriptionOptionsInit = {}) => {
          const state = read();
          if (state.permission === 'denied') {
            throw new DOMException('Registration failed - permission denied', 'NotAllowedError');
          }
          const key = options.applicationServerKey;
          write({
            permission: 'granted',
            isSubscribed: true,
            prompts: state.prompts + (state.permission === 'default' ? 1 : 0),
            serverKey: key instanceof Uint8Array ? base64url(key) : null,
          });
          return pushSubscription();
        },
      };
      const registration = {
        scope: `${location.origin}/`,
        pushManager,
      } as unknown as ServiceWorkerRegistration;
      const container = navigator.serviceWorker;
      const worker = {
        state: 'activated',
        scriptURL: `${location.origin}/ngsw-worker.js`,
        postMessage: (message: unknown) => {
          const nonce = (message as { nonce?: unknown } | null)?.nonce;
          if (typeof nonce === 'number') {
            // ngsw's answer to CHECK_FOR_UPDATES when the deploy is the one running.
            setTimeout(() => {
              container.dispatchEvent(
                new MessageEvent('message', { data: { type: 'OPERATION_COMPLETED', nonce, result: false } }),
              );
            });
          }
        },
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      } as unknown as ServiceWorker;
      Object.defineProperty(ServiceWorkerContainer.prototype, 'controller', {
        get: () => worker,
        configurable: true,
      });
      ServiceWorkerContainer.prototype.getRegistration = async () => registration;
    },
    { subscription, start, stateKey: STATE_KEY },
  );
}

/**
 * This device with push already on: the api stores a fake push device and the emulated browser holds it with the
 * permission granted, so the app reads "on" from the first load (Settings, the Snooze gate).
 */
export async function pushAlreadyOn(stack: Stack, context: BrowserContext): Promise<PushSubscriptionRequest> {
  const subscription = await fakePushDevice(stack);
  const api = await apiClient(stack);
  try {
    const stored = await api.put(PUSH_SUBSCRIPTIONS, { data: subscription });
    expect(stored.ok(), `PUT ${PUSH_SUBSCRIPTIONS}: ${stored.status()}`).toBe(true);
  } finally {
    await api.dispose();
  }
  await emulatePush(context, subscription, { permission: 'granted', isSubscribed: true });
  return subscription;
}

/** What the page did with the emulated push APIs so far. */
export async function pushRecord(page: Page): Promise<PushRecord> {
  const stored = await page.evaluate((key) => sessionStorage.getItem(key), STATE_KEY);
  if (stored === null) {
    throw new Error('push is not emulated on this page (emulatePush)');
  }
  return JSON.parse(stored) as PushRecord;
}

/**
 * The owner taps a notification whose link is `url`: what Angular's worker posts to its clients on `notificationclick`
 * (`NOTIFICATION_CLICK`, the message `SwPush.notificationClicks` reads), with the payload the api builds.
 */
export async function tapNotification(page: Page, url: string): Promise<void> {
  await page.evaluate((url) => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'NOTIFICATION_CLICK',
          data: {
            action: '',
            notification: {
              title: 'Team Console',
              data: { onActionClick: { default: { operation: 'navigateLastFocusedOrOpen', url } } },
            },
          },
        },
      }),
    );
  }, url);
}

/** The devices the api stores for the owner (`GET /api/v1/push/subscriptions`). */
export async function storedPushDevices(stack: Stack): Promise<number> {
  const api = await apiClient(stack);
  let body: unknown;
  try {
    const response = await api.get(PUSH_SUBSCRIPTIONS);
    expect(response.status()).toBe(200);
    body = await response.json();
  } finally {
    await api.dispose();
  }
  const devices = isRecord(body) ? body['devices'] : undefined;
  if (!Array.isArray(devices)) {
    throw new Error(`push subscriptions: no devices list in ${JSON.stringify(body)}`);
  }
  return devices.length;
}
