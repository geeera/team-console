import { iosVersionOf, platformOf, type PlatformSignals } from './platform';

/**
 * How this browser installs the console (#761 UX spec §2), one value per moment of a launch:
 * `standalone` the installed app itself · `installed` installed from this tab during this launch · `native` a kept
 * `beforeinstallprompt`, one tap · `menu` Chromium without the event (installed already, event spent, or not
 * installable yet) · `ios` / `ios-other` the Home Screen guide in Safari / in Chrome, Edge or Firefox on iOS ·
 * `in-app` another app's web view · `mac` / `mac-old` Safari on macOS 17+ / before 17 · `none` anything else.
 */
export type InstallPath =
  | 'standalone'
  | 'installed'
  | 'native'
  | 'menu'
  | 'ios'
  | 'ios-other'
  | 'in-app'
  | 'mac'
  | 'mac-old'
  | 'none';

export interface InstallState {
  /** A `beforeinstallprompt` is kept and not used yet. */
  readonly hasEvent: boolean;
  /** `appinstalled` fired, or the native dialog was accepted, during this launch. */
  readonly installedNow: boolean;
}

/** The paths the install card offers itself on; the others are for Settings only. */
export const INSTALL_CARD_PATHS: readonly InstallPath[] = ['native', 'ios', 'ios-other', 'mac'];

/** Safari 17 (macOS Sonoma) brought "Add to Dock". */
const FIRST_DOCK_SAFARI = 17;

const OTHER_IOS_BROWSER = /\b(?:CriOS|EdgiOS|FxiOS)\//;
const CHROMIUM = /\b(?:Chrome|Chromium|Edg|OPR|SamsungBrowser)\//;

export function installPathOf(signals: PlatformSignals, state: InstallState): InstallPath {
  const info = platformOf(signals);
  if (info.isStandalone) {
    return 'standalone';
  }
  if (state.installedNow) {
    return 'installed';
  }
  if (info.isIos) {
    if (info.isInAppBrowser) {
      return 'in-app';
    }
    return OTHER_IOS_BROWSER.test(signals.userAgent) ? 'ios-other' : 'ios';
  }
  if (state.hasEvent) {
    return 'native';
  }
  if (CHROMIUM.test(signals.userAgent)) {
    return 'menu';
  }
  if (info.settingsHost === 'safari') {
    const version = iosVersionOf(signals.userAgent);
    return version !== null && version[0] >= FIRST_DOCK_SAFARI ? 'mac' : 'mac-old';
  }
  return 'none';
}
