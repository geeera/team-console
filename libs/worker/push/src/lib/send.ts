import { encryptNotification, vapidHeaders } from '@block65/webcrypto-web-push';
import type { Logger } from '@worker/core';
import type { Environment } from '@shared/contracts';
import { forEnvironment, type PushNotification } from './message';
import { isAllowedPushEndpoint } from './subscription';
import type { VapidConfig } from './vapid';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** What the sender needs of a stored subscription. */
export interface StoredPushSubscription {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

/** Where subscriptions live (`PushSubscriptionsRepo` of `@worker/db` in the Workers). */
export interface PushSubscriptionStore {
  list(): Promise<readonly StoredPushSubscription[]>;
  markSuccess(endpoint: string, at: string): Promise<void>;
  /** Returns the failures in a row, or `null` once the row is deleted. */
  markFailure(endpoint: string, pruneAt: number): Promise<number | null>;
  remove(endpoint: string): Promise<boolean>;
}

export interface PushSendResult {
  readonly sent: number;
  readonly pruned: number;
  readonly failed: number;
}

export interface PushSenderOptions {
  readonly vapid: VapidConfig;
  /** The global `fetch` in a Worker; a fake push service in tests and local runs. */
  readonly fetch: FetchLike;
  readonly logger?: Logger;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  /** The sending Worker's environment: outside production every title is prefixed (#237, {@link forEnvironment}). */
  readonly environment: Environment;
}

/** A device is dropped after this many failed deliveries in a row (threat model on #11). */
export const PUSH_PRUNE_AFTER_FAILURES = 5;
/** Push services keep an undelivered message this long (24 h, architect note on #11). */
export const PUSH_TTL_S = 24 * 60 * 60;
const DEFAULT_TIMEOUT_MS = 10_000;

type Outcome = 'sent' | 'gone' | 'failed';

/**
 * Fan-out to every stored device, one at a time (ECDH + AES-GCM per device; 2–3 devices fit the 10 ms CPU budget,
 * ADR 0001). A device that fails never stops the others: 404/410 delete it, any other failure counts towards
 * {@link PUSH_PRUNE_AFTER_FAILURES}, and a success resets the count.
 */
export class PushSender {
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(private readonly options: PushSenderOptions) {
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async sendToAll(store: PushSubscriptionStore, message: PushNotification): Promise<PushSendResult> {
    const started = this.now();
    const plaintext = new TextEncoder().encode(JSON.stringify(forEnvironment(message, this.options.environment)));
    const subscriptions = await store.list();
    let sent = 0;
    let pruned = 0;
    let failed = 0;
    for (const subscription of subscriptions) {
      const outcome = await this.deliver(subscription, plaintext);
      if (outcome === 'sent') {
        await store.markSuccess(subscription.endpoint, new Date(this.now()).toISOString());
        sent += 1;
      } else if (outcome === 'gone') {
        await store.remove(subscription.endpoint);
        pruned += 1;
      } else if ((await store.markFailure(subscription.endpoint, PUSH_PRUNE_AFTER_FAILURES)) === null) {
        pruned += 1;
      } else {
        failed += 1;
      }
    }
    this.options.logger?.info('push fan-out', {
      devices: subscriptions.length,
      sent,
      pruned,
      failed,
      durationMs: this.now() - started,
    });
    return { sent, pruned, failed };
  }

  private async deliver(subscription: StoredPushSubscription, plaintext: Uint8Array): Promise<Outcome> {
    // Rows are checked on the way in; checked again here because this is the request that carries our VAPID JWT.
    if (!isAllowedPushEndpoint(subscription.endpoint)) {
      this.options.logger?.warn('push endpoint refused', { reason: 'not-allowed' });
      return 'gone';
    }
    // `pushService`, not `service`: the logger's context already uses `service` for the Worker's name.
    const pushService = new URL(subscription.endpoint).host;
    try {
      const target = {
        endpoint: subscription.endpoint,
        expirationTime: null,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      };
      const { headers } = await vapidHeaders(target, this.options.vapid);
      const body = await encryptNotification(target, plaintext);
      const response = await this.options.fetch(subscription.endpoint, {
        method: 'POST',
        headers: {
          ...headers,
          TTL: String(PUSH_TTL_S),
          Urgency: 'high',
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
        },
        body,
        // A push service never redirects; following one would send the JWT and payload elsewhere.
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      await response.body?.cancel();
      if (response.status >= 200 && response.status < 300) {
        return 'sent';
      }
      // Only the host and the status: the endpoint path is the device's capability URL.
      this.options.logger?.warn('push delivery refused', { pushService, status: response.status });
      return response.status === 404 || response.status === 410 ? 'gone' : 'failed';
    } catch (error: unknown) {
      this.options.logger?.warn('push delivery failed', {
        pushService,
        error: error instanceof Error ? error.name : 'unknown',
      });
      return 'failed';
    }
  }
}
