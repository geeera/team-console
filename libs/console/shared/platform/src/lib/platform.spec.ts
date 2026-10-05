import { iosVersionOf, platformOf, platformSignalsOf, type PlatformSignals } from './platform';

const IPHONE_SAFARI_26 =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const IPHONE_SAFARI_16_3 =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.3 Mobile/15E148 Safari/604.1';
const IPHONE_WEBVIEW =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const IPHONE_INSTAGRAM =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari/604.1 Instagram/330.0';
const IPAD_DESKTOP =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const MAC_SAFARI = IPAD_DESKTOP;
const MAC_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

function signals(overrides: Partial<PlatformSignals>): PlatformSignals {
  return {
    userAgent: MAC_CHROME,
    maxTouchPoints: 0,
    navigatorStandalone: undefined,
    displayModeStandalone: false,
    hasServiceWorker: true,
    hasPushManager: true,
    hasNotification: true,
    ...overrides,
  };
}

describe('platformOf', () => {
  it('lets a desktop browser with the push APIs turn notifications on', () => {
    const info = platformOf(signals({}));
    expect(info).toMatchObject({ isIos: false, webPush: 'ok', settingsHost: 'other' });
  });

  it('names Safari on the Mac for the "where to allow it" path', () => {
    expect(platformOf(signals({ userAgent: MAC_SAFARI })).settingsHost).toBe('safari');
  });

  it('says a desktop browser without the APIs has no web push', () => {
    expect(platformOf(signals({ hasPushManager: false })).webPush).toBe('no-push');
  });

  it('shows the Home Screen guide in iPhone Safari outside the installed app', () => {
    const info = platformOf(signals({ userAgent: IPHONE_SAFARI_26, hasPushManager: false, navigatorStandalone: false }));
    expect(info).toMatchObject({ isIos: true, isStandalone: false, webPush: 'install', settingsHost: 'ios' });
  });

  it('allows push in the installed iPhone app', () => {
    const info = platformOf(signals({ userAgent: IPHONE_SAFARI_26, navigatorStandalone: true }));
    expect(info).toMatchObject({ isStandalone: true, webPush: 'ok' });
  });

  it('reads the display-mode query as installed too', () => {
    expect(platformOf(signals({ userAgent: IPHONE_SAFARI_26, displayModeStandalone: true })).webPush).toBe('ok');
  });

  it('refuses iOS before 16.4, installed or not', () => {
    expect(platformOf(signals({ userAgent: IPHONE_SAFARI_16_3 })).webPush).toBe('old-ios');
    expect(platformOf(signals({ userAgent: IPHONE_SAFARI_16_3, navigatorStandalone: true })).webPush).toBe(
      'old-ios',
    );
  });

  it('treats an installed app without the APIs as an iOS too old to push', () => {
    const info = platformOf(signals({ userAgent: IPHONE_SAFARI_26, navigatorStandalone: true, hasPushManager: false }));
    expect(info.webPush).toBe('old-ios');
  });

  it('recognises a web view inside another app', () => {
    expect(platformOf(signals({ userAgent: IPHONE_WEBVIEW })).webPush).toBe('in-app');
    expect(platformOf(signals({ userAgent: IPHONE_INSTAGRAM })).webPush).toBe('in-app');
  });

  it('takes an iPad that asks for the desktop site for iOS by its touch screen', () => {
    const info = platformOf(signals({ userAgent: IPAD_DESKTOP, maxTouchPoints: 5 }));
    expect(info).toMatchObject({ isIos: true, webPush: 'install', settingsHost: 'ios' });
  });
});

describe('iosVersionOf', () => {
  it('prefers Safari’s Version over the frozen OS part', () => {
    expect(iosVersionOf(IPHONE_SAFARI_26)).toEqual([26, 0]);
  });

  it('falls back to the OS part', () => {
    expect(iosVersionOf(IPHONE_WEBVIEW)).toEqual([17, 5]);
  });

  it('gives null when neither is there', () => {
    expect(iosVersionOf('curl/8.0')).toBeNull();
  });
});

describe('platformSignalsOf', () => {
  it('reads nothing as supported without a window', () => {
    expect(platformSignalsOf(null)).toMatchObject({ hasServiceWorker: false, hasPushManager: false });
  });

  it('reads the jsdom window without throwing', () => {
    const read = platformSignalsOf(window);
    expect(read.userAgent).toBe(navigator.userAgent);
    expect(read.navigatorStandalone).toBeUndefined();
  });
});
