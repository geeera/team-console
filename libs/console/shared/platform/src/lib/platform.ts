import { DOCUMENT } from '@angular/common';
import { inject, Injectable } from '@angular/core';

/** What the browser tells about itself; read once from `window`, pure data so the rules below are testable. */
export interface PlatformSignals {
  readonly userAgent: string;
  readonly maxTouchPoints: number;
  /** iOS Safari's own flag for an app opened from the Home Screen; absent elsewhere. */
  readonly navigatorStandalone: boolean | undefined;
  /** `(display-mode: standalone)`: an installed web app on any platform. */
  readonly displayModeStandalone: boolean;
  readonly hasServiceWorker: boolean;
  readonly hasPushManager: boolean;
  readonly hasNotification: boolean;
}

/**
 * Whether this browser can receive web push, and if not, why — each reason has its own advice:
 * `install` iOS Safari outside the Home Screen app (iOS only pushes to installed web apps), `old-ios` before 16.4,
 * `in-app` a web view inside another app, `no-push` a browser without the APIs.
 */
export type WebPushSupport = 'ok' | 'install' | 'old-ios' | 'in-app' | 'no-push';

/** Whose settings to point at when a permission was refused. */
export type SettingsHost = 'ios' | 'safari' | 'other';

export interface PlatformInfo {
  readonly isIos: boolean;
  /** Safari's (= iOS's) version as major and minor, when the user agent carries one. */
  readonly iosVersion: readonly [number, number] | null;
  readonly isStandalone: boolean;
  readonly isInAppBrowser: boolean;
  readonly settingsHost: SettingsHost;
  readonly webPush: WebPushSupport;
}

/** iOS 16.4 brought web push to Home Screen apps. */
const FIRST_PUSH_IOS: readonly [number, number] = [16, 4];

// Web views of other apps (Facebook, Instagram, LINE, Telegram, the Google app) cannot add to the Home Screen.
const IN_APP = /\b(?:FBAN|FBAV|Instagram|Line|Telegram|GSA)\//;
const OTHER_ENGINES = /\b(?:Chrome|Chromium|CriOS|Edg|EdgiOS|OPR|Firefox|FxiOS)\//;

function isIosAgent(signals: PlatformSignals): boolean {
  // iPadOS asks for the desktop site and says "Macintosh"; only the touch screen gives it away.
  return /\b(?:iPhone|iPad|iPod)\b/.test(signals.userAgent) ||
    (/\bMacintosh\b/.test(signals.userAgent) && signals.maxTouchPoints > 1);
}

/**
 * Safari's `Version/x.y` follows iOS (iOS 26 froze the `OS 18_6` part of the agent); the `OS x_y` part is the
 * fallback for agents without `Version/`.
 */
export function iosVersionOf(userAgent: string): readonly [number, number] | null {
  const match = /\bVersion\/(\d+)(?:\.(\d+))?/.exec(userAgent) ?? /\bOS (\d+)(?:_(\d+))?/.exec(userAgent);
  if (match === null || match[1] === undefined) {
    return null;
  }
  return [Number(match[1]), Number(match[2] ?? '0')];
}

function isBefore(version: readonly [number, number], than: readonly [number, number]): boolean {
  return version[0] < than[0] || (version[0] === than[0] && version[1] < than[1]);
}

export function platformOf(signals: PlatformSignals): PlatformInfo {
  const isIos = isIosAgent(signals);
  const iosVersion = isIos ? iosVersionOf(signals.userAgent) : null;
  const isStandalone = signals.navigatorStandalone === true || signals.displayModeStandalone;
  const isInAppBrowser = isIos && (!/\bSafari\//.test(signals.userAgent) || IN_APP.test(signals.userAgent));
  const hasPushApis = signals.hasServiceWorker && signals.hasPushManager && signals.hasNotification;
  const isDesktopSafari =
    !isIos && /\bSafari\//.test(signals.userAgent) && !OTHER_ENGINES.test(signals.userAgent);

  let webPush: WebPushSupport;
  if (!isIos) {
    webPush = hasPushApis ? 'ok' : 'no-push';
  } else if (iosVersion !== null && isBefore(iosVersion, FIRST_PUSH_IOS)) {
    webPush = 'old-ios';
  } else if (isStandalone) {
    // An installed app without the APIs is an iOS too old to say so in its agent.
    webPush = hasPushApis ? 'ok' : 'old-ios';
  } else {
    webPush = isInAppBrowser ? 'in-app' : 'install';
  }

  return {
    isIos,
    iosVersion,
    isStandalone,
    isInAppBrowser,
    settingsHost: isIos ? 'ios' : isDesktopSafari ? 'safari' : 'other',
    webPush,
  };
}

/** The signals of the window the app runs in; a missing window (tests without one) reads as "no push". */
export function platformSignalsOf(view: (Window & typeof globalThis) | null): PlatformSignals {
  if (view === null) {
    return {
      userAgent: '',
      maxTouchPoints: 0,
      navigatorStandalone: undefined,
      displayModeStandalone: false,
      hasServiceWorker: false,
      hasPushManager: false,
      hasNotification: false,
    };
  }
  const navigator = view.navigator as Navigator & { standalone?: unknown };
  return {
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
    navigatorStandalone: typeof navigator.standalone === 'boolean' ? navigator.standalone : undefined,
    displayModeStandalone: view.matchMedia?.('(display-mode: standalone)').matches ?? false,
    hasServiceWorker: 'serviceWorker' in navigator,
    hasPushManager: 'PushManager' in view,
    hasNotification: 'Notification' in view,
  };
}

/** This device as the app sees it, read once: none of it changes while the app runs. */
@Injectable({ providedIn: 'root' })
export class Platform {
  readonly info: PlatformInfo = platformOf(platformSignalsOf(inject(DOCUMENT).defaultView));
}
