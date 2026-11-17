import { inject } from '@angular/core';
import {
  RedirectCommand,
  Router,
  type CanActivateFn,
  type Params,
  type RedirectFunction,
  type Route,
} from '@angular/router';
import { DeploymentStore } from '@console/entities/app-info';
import { environmentCopyReady } from '@console/entities/environment';
import { projectEnvironmentGuideRouteOf } from '@console/entities/project';
import { isEnvironment, type Environment } from '@shared/contracts';
import { CONSOLE_ENVIRONMENT_PATH } from './environment-paths';

/** When the console cannot tell its own environment, the tab that matters most opens. */
const FALLBACK_ENVIRONMENT: Environment = 'production';

/** `/admin/environment` and an unknown `:env` open this console's own environment (#104 UX spec §1). */
const toKnownEnvironment: CanActivateFn = async (route) => {
  const env: unknown = route.paramMap.get('env');
  if (isEnvironment(env)) {
    return true;
  }
  const deployment = inject(DeploymentStore);
  const router = inject(Router);
  await deployment.ensureLoaded();
  return new RedirectCommand(
    router.createUrlTree([CONSOLE_ENVIRONMENT_PATH, deployment.environment() ?? FALLBACK_ENVIRONMENT], {
      queryParams: route.queryParams,
      ...(route.fragment === null ? {} : { fragment: route.fragment }),
    }),
    { replaceUrl: true },
  );
};

/** An old address's redirect (#750 UX spec §7): the new one, its query and fragment kept. */
function redirectKeeping(commands: (params: Params) => readonly string[]): RedirectFunction {
  return ({ params, queryParams, fragment }) =>
    inject(Router).createUrlTree([...commands(params)], {
      queryParams,
      ...(fragment === null ? {} : { fragment }),
    });
}

const projectGuideOf = (params: Params): readonly string[] =>
  projectEnvironmentGuideRouteOf(String(params['slug']), String(params['env']), String(params['name']));

/**
 * The operator screen (#104, moved by #750) under `/admin/environment`: its own lazy chunk (the manifest and the
 * guides ride in it), its copy merged first. The guide is a child of the list so a wide screen shows both
 * (list-detail) and the URL keeps the open guide through Back and a reload. `place` is in the guide's URL because one
 * name can live in two places (`VAPID_PRIVATE_KEY` on `api` and `hooks`).
 */
export const consoleEnvironmentRoutes: Route[] = [
  {
    path: 'environment',
    canActivate: [environmentCopyReady],
    children: [
      { path: '', pathMatch: 'full', canActivate: [toKnownEnvironment], children: [] },
      // Never published; a per-project guide lives on its project's screen.
      { path: ':env/project/:slug/:name', pathMatch: 'full', redirectTo: redirectKeeping(projectGuideOf) },
      {
        path: ':env',
        canActivate: [toKnownEnvironment],
        loadComponent: () => import('./console-environment.page').then((m) => m.ConsoleEnvironmentPage),
        children: [
          {
            path: ':place/:name',
            loadComponent: () => import('./environment-guide.page').then((m) => m.EnvironmentGuidePage),
          },
        ],
      },
    ],
  },
];

/**
 * Under `/settings` (#750): a project's environment at `projects/:slug/environment` — a sub-page of its setup, its
 * guide at `:env/:name` — and the old `/settings/environment/…` addresses, redirected. The project guide's redirect
 * comes before the `:place/:name` one, as the routes did.
 */
export const environmentRoutes: Route[] = [
  {
    path: 'projects/:slug/environment',
    canActivate: [environmentCopyReady],
    loadComponent: () => import('./project-environment.page').then((m) => m.ProjectEnvironmentPage),
    children: [
      {
        path: ':env/:name',
        loadComponent: () => import('./environment-guide.page').then((m) => m.EnvironmentGuidePage),
      },
    ],
  },
  {
    path: 'environment',
    pathMatch: 'full',
    redirectTo: redirectKeeping(() => [CONSOLE_ENVIRONMENT_PATH]),
  },
  {
    path: 'environment/:env/project/:slug/:name',
    pathMatch: 'full',
    redirectTo: redirectKeeping(projectGuideOf),
  },
  {
    path: 'environment/:env/:place/:name',
    pathMatch: 'full',
    redirectTo: redirectKeeping((params) => [
      CONSOLE_ENVIRONMENT_PATH,
      String(params['env']),
      String(params['place']),
      String(params['name']),
    ]),
  },
  {
    path: 'environment/:env',
    pathMatch: 'full',
    redirectTo: redirectKeeping((params) => [CONSOLE_ENVIRONMENT_PATH, String(params['env'])]),
  },
];
