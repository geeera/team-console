import { DOCUMENT } from '@angular/common';
import { inject, Injectable, signal } from '@angular/core';
import { deviceStorageOf } from '@console/shared/platform';

/** This device's "Not now" on the Needs you nudge; never sent anywhere. */
export const PUSH_NUDGE_KEY = 'tc.push-nudge.v1';
const DISMISSED = 'dismissed';

/**
 * Navigation state that asks Settings to open the Home Screen steps of its App section (#761): on iPhone Safari the
 * nudge's "How to turn on" means "install first", and App owns that guide.
 */
export const FOCUS_APP_SETTINGS_STATE = 'tcFocusAppSettings';

/**
 * Remembers on this device that the owner hid the nudge. Storage may be unavailable (private browsing, a full
 * quota): then the choice lasts until the app is closed, which is the honest fallback.
 */
@Injectable({ providedIn: 'root' })
export class PushNudgeMemory {
  private readonly storage = deviceStorageOf(inject(DOCUMENT).defaultView, 'push nudge');

  readonly isDismissed = signal(this.storage.read(PUSH_NUDGE_KEY) === DISMISSED);

  dismiss(): void {
    this.isDismissed.set(true);
    this.storage.write(PUSH_NUDGE_KEY, DISMISSED);
  }
}
