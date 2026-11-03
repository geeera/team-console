import { DOCUMENT } from '@angular/common';
import { inject, Injectable } from '@angular/core';
import { SwPush } from '@angular/service-worker';
import { firstValueFrom, of, take, timeout } from 'rxjs';

/**
 * How long reading this browser's subscription may take. `SwPush.subscription` answers once the service worker
 * controls the page; on a first visit that can be later than a screen should show a skeleton.
 */
export const SUBSCRIPTION_READ_TIMEOUT_MS = 4_000;

/**
 * This browser's side of web push, through Angular's `SwPush` (#36: no custom service worker). Reading never asks
 * for anything; only `subscribe()` can bring up the permission prompt, and only a tap calls it.
 */
@Injectable({ providedIn: 'root' })
export class PushDevice {
  private readonly swPush = inject(SwPush, { optional: true });
  private readonly view = inject(DOCUMENT).defaultView;

  /** False in development builds (no service worker) and where the browser has none. */
  get isEnabled(): boolean {
    return this.swPush?.isEnabled ?? false;
  }

  permission(): NotificationPermission {
    const notification = this.view?.Notification;
    return notification === undefined ? 'default' : notification.permission;
  }

  /** The subscription the browser holds for this app, or null (none, or no answer in time). */
  async current(timeoutMs = SUBSCRIPTION_READ_TIMEOUT_MS): Promise<PushSubscription | null> {
    if (this.swPush === null || !this.swPush.isEnabled) {
      return null;
    }
    return firstValueFrom(this.swPush.subscription.pipe(take(1), timeout({ first: timeoutMs, with: () => of(null) })));
  }

  /** Asks the browser for a subscription: shows the permission prompt while the permission is not decided yet. */
  async subscribe(serverPublicKey: string): Promise<PushSubscription> {
    if (this.swPush === null) {
      throw new Error('web push needs the service worker');
    }
    return this.swPush.requestSubscription({ serverPublicKey });
  }

  /** Drops the browser's subscription; nothing to do when it has none. */
  async unsubscribe(): Promise<void> {
    if (this.swPush === null || (await this.current()) === null) {
      return;
    }
    await this.swPush.unsubscribe();
  }
}
