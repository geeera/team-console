import type { Route } from '@angular/router';
import { consoleEnvironmentRoutes } from './environment/environment.routes';

/**
 * The operator area under `/admin` (#750, ADR 0008 decision 2's `operator` scope): today the console's own
 * environment only. Settings links it only once the environment status answered 200; anyone else who types the
 * address gets the screen's forbidden state, never a row.
 */
export const adminRoutes: Route[] = [...consoleEnvironmentRoutes];
