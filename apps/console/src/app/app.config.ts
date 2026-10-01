import {
  ApplicationConfig,
  isDevMode,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';
import { provideConsoleApi } from '@console/shared/api';
import { provideAppConfig } from '@console/shared/config';
import { provideConsoleI18n } from '@console/shared/i18n';
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
  ],
};
