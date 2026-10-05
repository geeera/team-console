import { HttpErrorResponse } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { httpProblemOf } from '@console/shared/api';
import { Platform, type WebPushSupport } from '@console/shared/platform';
import { PUSH_TEST_INTERVAL_S, type PushDeviceDto, type PushSubscriptionRequest } from '@shared/contracts';
import { deviceIdOf, PushApi, subscriptionRequestOf, UnexpectedPushResponse } from './push.api';
import { PushDevice } from './push-device';

/** Where this device stands; `asking` waits for the browser's permission prompt, `saving` for the Worker. */
export type PushPhase = 'checking' | 'off' | 'asking' | 'saving' | 'on' | 'denied';

/** Why the last Turn on did not finish: the Worker refused, the network was gone, or the browser failed. */
export type PushFailure = 'server' | 'offline' | 'device';

/** What Settings shows: the phase where push works here, else why it cannot. */
export type PushView = PushPhase | Exclude<WebPushSupport, 'ok'>;

export type PushTestOutcome =
  | { readonly kind: 'sent'; readonly devices: number }
  | { readonly kind: 'wait'; readonly seconds: number }
  | { readonly kind: 'failed' };

export type TurnOffResult = 'off' | 'failed';

/** A Worker answer as the owner reads it; anything that is not an answer is a bug and is thrown on. */
function failureOf(error: unknown): PushFailure {
  if (error instanceof UnexpectedPushResponse) {
    return 'server';
  }
  return httpProblemOf(error).status === 0 ? 'offline' : 'server';
}

function testOutcomeOf(error: unknown): PushTestOutcome {
  if (!(error instanceof HttpErrorResponse)) {
    if (error instanceof UnexpectedPushResponse) {
      return { kind: 'failed' };
    }
    throw error;
  }
  const problem = httpProblemOf(error);
  return problem.status === 429
    ? { kind: 'wait', seconds: problem.retryAfterSeconds ?? PUSH_TEST_INTERVAL_S }
    : { kind: 'failed' };
}

/**
 * Web push on this device (#36): read on load from `Notification.permission` and `SwPush.subscription`, never
 * asked for. `enable()` is the only way to the permission prompt and is called from a button's click only. A
 * subscription the Worker refused is kept, so Try again saves it again without a second prompt.
 */
@Injectable({ providedIn: 'root' })
export class PushStore {
  private readonly api = inject(PushApi);
  private readonly device = inject(PushDevice);

  /** The browser and platform; a build without the service worker counts as a browser without push. */
  readonly support: WebPushSupport = (() => {
    const support = inject(Platform).info.webPush;
    return support === 'ok' && !this.device.isEnabled ? 'no-push' : support;
  })();

  readonly phase = signal<PushPhase>('checking');
  /** `Notification.permission` as last read: on load, after Check again and after the prompt. */
  readonly permission = signal<NotificationPermission>('default');
  readonly failure = signal<PushFailure | null>(null);
  /** When the Worker first stored this device (ISO 8601), once known. */
  readonly since = signal<string | null>(null);
  readonly isTesting = signal(false);
  readonly testOutcome = signal<PushTestOutcome | null>(null);
  readonly isTurningOff = signal(false);
  /** A subscription the browser gave but the Worker has not stored: Try again saves this one. */
  readonly hasPendingSave = signal(false);

  readonly view = computed<PushView>(() => (this.support === 'ok' ? this.phase() : this.support));
  readonly isBusy = computed(() => this.phase() === 'asking' || this.phase() === 'saving');
  readonly isOn = computed(() => this.view() === 'on');

  private pending: PushSubscriptionRequest | null = null;
  private endpoint: string | null = null;
  private key: Promise<string> | null = null;
  private reading: Promise<void> | null = null;

  /**
   * Re-reads the permission and this browser's subscription. Never subscribes, never prompts: "Check again" and
   * every screen that shows push call this.
   */
  refresh(): Promise<void> {
    if (this.support !== 'ok' || this.isBusy()) {
      return Promise.resolve();
    }
    this.reading ??= this.read().finally(() => (this.reading = null));
    return this.reading;
  }

  /** Turn on, from a tap only: the prompt when undecided, then subscribe and save; a kept subscription is re-saved. */
  async enable(): Promise<void> {
    if (this.support !== 'ok' || this.isBusy()) {
      return;
    }
    this.failure.set(null);
    this.testOutcome.set(null);
    if (this.pending !== null) {
      await this.save(this.pending);
      return;
    }
    const permission = this.readPermission();
    if (permission === 'denied') {
      this.phase.set('denied');
      return;
    }
    let key: string;
    try {
      key = await this.publicKey();
    } catch (error: unknown) {
      this.fail(failureOf(error));
      return;
    }
    this.phase.set(permission === 'granted' ? 'saving' : 'asking');
    let subscription: PushSubscription;
    try {
      subscription = await this.device.subscribe(key);
    } catch (error: unknown) {
      const answer = this.readPermission();
      if (answer !== 'granted') {
        // Refused or dismissed: the prompt's answer is the outcome, not a failure.
        this.phase.set(answer === 'denied' ? 'denied' : 'off');
        return;
      }
      this.fail('device', error);
      return;
    }
    this.readPermission();
    const request = subscriptionRequestOf(subscription.toJSON());
    if (request === null) {
      this.fail('device', new Error('the browser returned a subscription without keys'));
      return;
    }
    await this.save(request);
  }

  /** Turn off: the Worker forgets this device first, then the browser drops its subscription. */
  async turnOff(): Promise<TurnOffResult> {
    if (this.isTurningOff()) {
      return 'failed';
    }
    this.isTurningOff.set(true);
    try {
      const endpoint = this.endpoint ?? (await this.device.current())?.endpoint ?? null;
      if (endpoint !== null) {
        await this.api.remove(endpoint);
      }
      await this.device.unsubscribe();
      this.endpoint = null;
      this.since.set(null);
      this.testOutcome.set(null);
      this.failure.set(null);
      this.phase.set('off');
      return 'off';
    } catch (error: unknown) {
      console.error('push: turning off failed', error);
      return 'failed';
    } finally {
      this.isTurningOff.set(false);
    }
  }

  /** Sends the fixed test notification to every device; the Worker accepts one per 30 s. */
  async sendTest(language: 'ru' | 'en'): Promise<void> {
    if (this.isTesting()) {
      return;
    }
    this.isTesting.set(true);
    this.testOutcome.set(null);
    try {
      const result = await this.api.sendTest(language);
      this.testOutcome.set(result.sent > 0 ? { kind: 'sent', devices: result.sent } : { kind: 'failed' });
    } catch (error: unknown) {
      this.testOutcome.set(testOutcomeOf(error));
    } finally {
      this.isTesting.set(false);
    }
  }

  private readPermission(): NotificationPermission {
    const permission = this.device.permission();
    this.permission.set(permission);
    return permission;
  }

  private async read(): Promise<void> {
    const permission = this.readPermission();
    if (permission === 'denied') {
      this.phase.set('denied');
      return;
    }
    const subscription = permission === 'granted' ? await this.device.current() : null;
    if (subscription === null) {
      this.phase.set('off');
      this.prefetchKey();
      return;
    }
    this.endpoint = subscription.endpoint;
    this.phase.set('on');
    let devices: readonly PushDeviceDto[];
    try {
      devices = await this.api.devices();
    } catch (error: unknown) {
      // Offline or a refused list: the browser's subscription is the best answer there is; the date stays unknown.
      console.warn('push: could not read the device list', error);
      return;
    }
    const id = await deviceIdOf(subscription.endpoint);
    const stored = devices.find((device) => device.id === id);
    if (stored !== undefined) {
      this.since.set(stored.createdAt);
      return;
    }
    // The Worker dropped this device (pruned or evicted): it is off until the owner taps Turn on again.
    this.pending = subscriptionRequestOf(subscription.toJSON());
    this.hasPendingSave.set(false);
    this.phase.set('off');
  }

  private async save(request: PushSubscriptionRequest): Promise<void> {
    this.pending = request;
    this.phase.set('saving');
    try {
      await this.api.save(request);
    } catch (error: unknown) {
      this.fail(failureOf(error));
      this.hasPendingSave.set(true);
      return;
    }
    this.pending = null;
    this.hasPendingSave.set(false);
    this.endpoint = request.endpoint;
    this.since.set(new Date().toISOString());
    this.phase.set('on');
  }

  private fail(failure: PushFailure, cause?: unknown): void {
    if (cause !== undefined) {
      console.error('push: turning on failed', cause);
    }
    this.failure.set(failure);
    this.phase.set('off');
  }

  private publicKey(): Promise<string> {
    if (this.key === null) {
      const key = this.api.publicKey();
      this.key = key;
      // A failed fetch is forgotten, so the next tap asks the Worker again instead of replaying the failure.
      key.catch(() => {
        if (this.key === key) {
          this.key = null;
        }
      });
    }
    return this.key;
  }

  /** The key is fetched ahead of the tap, so the browser's prompt opens within the tap's user gesture. */
  private prefetchKey(): void {
    // Its failure is reported by the tap that needs the key, not here.
    this.publicKey().catch(() => undefined);
  }
}
