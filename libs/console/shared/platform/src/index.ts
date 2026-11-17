export { AppBadge, setAppBadge } from './lib/app-badge';
export type { AppBadgeResult } from './lib/app-badge';
export { deviceStorageOf } from './lib/device-storage';
export type { DeviceStorage } from './lib/device-storage';
export { INSTALL_CARD_PATHS, installPathOf } from './lib/install-path';
export type { InstallPath, InstallState } from './lib/install-path';
export {
  captureInstallPrompt,
  INSTALL_PROMPT_CAPTURE,
  InstallPrompt,
  InstallPromptCapture,
  isBeforeInstallPromptEvent,
} from './lib/install-prompt';
export type { BeforeInstallPromptEvent, InstallOutcome } from './lib/install-prompt';
export { Platform, iosVersionOf, platformOf, platformSignalsOf } from './lib/platform';
export type { PlatformInfo, PlatformSignals, SettingsHost, WebPushSupport } from './lib/platform';
