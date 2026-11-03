import {
  ApplicationConfig,
  isDevMode,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';
import { providePushTaps } from '@console/entities/push';
import { provideConsoleApi } from '@console/shared/api';
import { provideAppConfig } from '@console/shared/config';
import { provideConsoleI18n } from '@console/shared/i18n';
import { provideAppUpdates } from './app-updates';
import { appRoutes } from './app.routes';
import { buildInfo } from './build-info';
import { serviceWorkerOptions } from './pwa';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideBrowserGlobalErrorListeners(),
    provideRouter(appRoutes, withComponentInputBinding()),
    provideAppConfig({ name: 'Team Console', ...buildInfo }),
    provideConsoleI18n({ start: 'remembered' }),
    provideConsoleApi(),
    provideServiceWorker('ngsw-worker.js', serviceWorkerOptions(!isDevMode())),
    // New deploys reach a PWA that is never closed, and a broken worker heals itself (#306).
    provideAppUpdates(),
    // A tapped notification opens its item inside the running app too (#36); only Worker-built targets.
    providePushTaps(),
  ],
};
