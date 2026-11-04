import { inject } from '@angular/core';
import { Router, type CanActivateFn, type Route } from '@angular/router';
import { DeploymentStore } from '@console/entities/app-info';
import { environmentCopyReady } from '@console/entities/environment';
import { isEnvironment, type Environment } from '@shared/contracts';

/** When the console cannot tell its own environment, the tab that matters most opens. */
const FALLBACK_ENVIRONMENT: Environment = 'production';

/** `/settings/environment` and an unknown `:env` open this console's own environment (UX spec §1). */
const toKnownEnvironment: CanActivateFn = async (route) => {
  const env: unknown = route.paramMap.get('env');
  if (isEnvironment(env)) {
    return true;
  }
  const deployment = inject(DeploymentStore);
  const router = inject(Router);
  await deployment.ensureLoaded();
  return router.createUrlTree(['/settings/environment', deployment.environment() ?? FALLBACK_ENVIRONMENT]);
};

/**
 * Environment setup (#104) under `/settings/environment`: its own lazy chunk (the manifest and the guides ride in
 * it), its copy merged first. The guide is a child of the list so a wide screen shows both (list-detail) and the
 * URL keeps the open guide through Back and a reload. `place` is in the guide's URL because one name can live in
 * two places (`VAPID_PRIVATE_KEY` on `api` and `hooks`).
 */
export const environmentRoutes: Route[] = [
  {
    path: 'environment',
    canActivate: [environmentCopyReady],
    children: [
      { path: '', pathMatch: 'full', canActivate: [toKnownEnvironment], children: [] },
      {
        path: ':env',
        canActivate: [toKnownEnvironment],
        loadComponent: () => import('./environment-setup.page').then((m) => m.EnvironmentSetupPage),
        children: [
          {
            path: 'project/:slug/:name',
            loadComponent: () => import('./environment-guide.page').then((m) => m.EnvironmentGuidePage),
          },
          {
            path: ':place/:name',
            loadComponent: () => import('./environment-guide.page').then((m) => m.EnvironmentGuidePage),
          },
        ],
      },
    ],
  },
];
