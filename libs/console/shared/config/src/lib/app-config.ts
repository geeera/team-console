import { InjectionToken, Provider } from '@angular/core';

/** Build-time facts about the running client; the app supplies them at bootstrap. */
export interface AppConfig {
  readonly name: string;
  readonly version: string;
  /** ISO timestamp of the build, or `local` for a developer build. */
  readonly builtAt: string;
}

export const APP_CONFIG = new InjectionToken<AppConfig>('APP_CONFIG');

export function provideAppConfig(config: AppConfig): Provider {
  return { provide: APP_CONFIG, useValue: config };
}
