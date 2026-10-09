import { bootstrapApplication } from '@angular/platform-browser';
import { stripReloginMarker } from '@console/shared/api';
import { appConfig } from './app/app.config';
import { App } from './app/app';

// Back from an Access login (#284): the router must not see the service-worker bypass marker.
stripReloginMarker(window);

bootstrapApplication(App, appConfig).catch((err) => console.error(err));
