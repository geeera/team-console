import { bootstrapApplication } from '@angular/platform-browser';
import { stripReloginMarker } from '@console/shared/api';
import { captureInstallPrompt } from '@console/shared/platform';
import { appConfig } from './app/app.config';
import { App } from './app/app';

// Back from an Access login (#284): the router must not see the service-worker bypass marker.
stripReloginMarker(window);
// Chromium may offer installing before Angular is up (#761): keep the event, or it becomes Chrome's own infobar.
captureInstallPrompt(window);

bootstrapApplication(App, appConfig).catch((err) => console.error(err));
