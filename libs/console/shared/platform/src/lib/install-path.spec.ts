import { installPathOf, type InstallState } from './install-path';
import type { PlatformSignals } from './platform';

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const IPHONE_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1';
const IPHONE_EDGE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 EdgiOS/141.0 Mobile/15E148 Safari/605.1.15';
const IPHONE_FIREFOX =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/144.0 Mobile/15E148 Safari/605.1.15';
const IPHONE_TELEGRAM =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari/604.1 Telegram/11.0';
const IPHONE_WEBVIEW =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
const ANDROID_SAMSUNG =
  'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36';
const MAC_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const WIN_EDGE =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0';
const MAC_SAFARI_18 =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15';
const MAC_SAFARI_16 =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15';
const MAC_FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:144.0) Gecko/20100101 Firefox/144.0';

function signals(userAgent: string, overrides: Partial<PlatformSignals> = {}): PlatformSignals {
  return {
    userAgent,
    maxTouchPoints: 0,
    navigatorStandalone: undefined,
    displayModeStandalone: false,
    hasServiceWorker: true,
    hasPushManager: true,
    hasNotification: true,
    ...overrides,
  };
}

const NO_EVENT: InstallState = { hasEvent: false, installedNow: false };
const EVENT: InstallState = { hasEvent: true, installedNow: false };

describe('installPathOf', () => {
  it('offers nothing inside the installed app, on any platform', () => {
    expect(installPathOf(signals(MAC_CHROME, { displayModeStandalone: true }), EVENT)).toBe('standalone');
    expect(installPathOf(signals(IPHONE_SAFARI, { navigatorStandalone: true }), NO_EVENT)).toBe('standalone');
  });

  it('says installed once the tab installed the app during this launch', () => {
    expect(installPathOf(signals(ANDROID_CHROME), { hasEvent: false, installedNow: true })).toBe('installed');
  });

  it.each([
    ['Android Chrome', ANDROID_CHROME],
    ['Samsung Internet', ANDROID_SAMSUNG],
    ['Mac Chrome', MAC_CHROME],
    ['Windows Edge', WIN_EDGE],
  ])('offers one tap in %s with a kept install event', (_name, agent) => {
    expect(installPathOf(signals(agent), EVENT)).toBe('native');
  });

  it.each([
    ['Android Chrome', ANDROID_CHROME],
    ['Mac Chrome', MAC_CHROME],
    ['Windows Edge', WIN_EDGE],
  ])('points %s without the event to the browser menu', (_name, agent) => {
    expect(installPathOf(signals(agent), NO_EVENT)).toBe('menu');
  });

  it('shows the Safari guide on iPhone Safari', () => {
    expect(installPathOf(signals(IPHONE_SAFARI, { maxTouchPoints: 5 }), NO_EVENT)).toBe('ios');
  });

  it.each([
    ['Chrome', IPHONE_CHROME],
    ['Edge', IPHONE_EDGE],
    ['Firefox', IPHONE_FIREFOX],
  ])('shows the other-browser guide in %s on iPhone', (_name, agent) => {
    expect(installPathOf(signals(agent), NO_EVENT)).toBe('ios-other');
  });

  it('offers nothing in another app’s web view', () => {
    expect(installPathOf(signals(IPHONE_TELEGRAM), NO_EVENT)).toBe('in-app');
    expect(installPathOf(signals(IPHONE_WEBVIEW), NO_EVENT)).toBe('in-app');
  });

  it('gives macOS Safari 17+ the Dock hint and older Safari none', () => {
    expect(installPathOf(signals(MAC_SAFARI_18), NO_EVENT)).toBe('mac');
    expect(installPathOf(signals(MAC_SAFARI_16), NO_EVENT)).toBe('mac-old');
  });

  it('reads an iPad asking for the desktop site as iOS, not as macOS Safari', () => {
    expect(installPathOf(signals(MAC_SAFARI_18, { maxTouchPoints: 5 }), NO_EVENT)).toBe('ios');
  });

  it('says Firefox on the desktop cannot install', () => {
    expect(installPathOf(signals(MAC_FIREFOX), NO_EVENT)).toBe('none');
  });
});
