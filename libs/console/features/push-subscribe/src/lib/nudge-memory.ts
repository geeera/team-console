import { DOCUMENT } from '@angular/common';
import { inject, Injectable, signal } from '@angular/core';

/** This device's "Not now" on the Needs you nudge; never sent anywhere. */
export const PUSH_NUDGE_KEY = 'tc.push-nudge.v1';
const DISMISSED = 'dismissed';

/** Navigation state that asks Settings to bring the Notifications block into view (the nudge's "How to turn on"). */
export const FOCUS_PUSH_SETTINGS_STATE = 'tcFocusPushSettings';

/**
 * Remembers on this device that the owner hid the nudge. Storage may be unavailable (private browsing, a full
 * quota): then the choice lasts until the app is closed, which is the honest fallback.
 */
@Injectable({ providedIn: 'root' })
export class PushNudgeMemory {
  private readonly storage = (() => {
    try {
      return inject(DOCUMENT).defaultView?.localStorage ?? null;
    } catch (error: unknown) {
      // Reading `localStorage` itself throws where storage is blocked.
      console.warn('push nudge: storage unavailable', error);
      return null;
    }
  })();

  readonly isDismissed = signal(this.read());

  dismiss(): void {
    this.isDismissed.set(true);
    try {
      this.storage?.setItem(PUSH_NUDGE_KEY, DISMISSED);
    } catch (error: unknown) {
      console.warn('push nudge: could not remember "Not now"', error);
    }
  }

  private read(): boolean {
    try {
      return this.storage?.getItem(PUSH_NUDGE_KEY) === DISMISSED;
    } catch (error: unknown) {
      console.warn('push nudge: could not read "Not now"', error);
      return false;
    }
  }
}
