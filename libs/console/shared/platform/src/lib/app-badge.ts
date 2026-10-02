import { DOCUMENT } from '@angular/common';
import { inject, Injectable } from '@angular/core';

/** The Badging API where the browser has it (installed web apps on iOS 16.4+, Chromium, Safari on macOS). */
interface BadgingNavigator {
  setAppBadge?: (contents?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
}

/**
 * `set` and `cleared` say what the icon shows now; `unsupported` is a browser without the API; `refused` is the
 * browser saying no (iOS before notifications are allowed), which leaves the icon as it was.
 */
export type AppBadgeResult = 'set' | 'cleared' | 'unsupported' | 'refused';

/** Sets the number on the app icon, or clears it at 0; a no-op where the Badging API is missing. */
export async function setAppBadge(navigator: BadgingNavigator, count: number): Promise<AppBadgeResult> {
  const value = Number.isSafeInteger(count) && count > 0 ? count : 0;
  try {
    if (value === 0) {
      if (typeof navigator.clearAppBadge !== 'function') {
        return 'unsupported';
      }
      await navigator.clearAppBadge();
      return 'cleared';
    }
    if (typeof navigator.setAppBadge !== 'function') {
      return 'unsupported';
    }
    await navigator.setAppBadge(value);
    return 'set';
  } catch (error: unknown) {
    // NotAllowedError / SecurityError are the browser's answer, not a bug: the badge just stays as it was.
    if (error instanceof DOMException) {
      return 'refused';
    }
    throw error;
  }
}

@Injectable({ providedIn: 'root' })
export class AppBadge {
  private readonly view = inject(DOCUMENT).defaultView;

  set(count: number): Promise<AppBadgeResult> {
    return this.view === null ? Promise.resolve('unsupported') : setAppBadge(this.view.navigator, count);
  }
}
