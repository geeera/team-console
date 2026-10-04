import { SwRegistrationOptions } from '@angular/service-worker';

/**
 * ngsw registers only in production builds and after the app is stable
 * (or 30 s), so the first paint never competes with the worker install.
 */
export function serviceWorkerOptions(isProduction: boolean): SwRegistrationOptions {
  return { enabled: isProduction, registrationStrategy: 'registerWhenStable:30000' };
}
