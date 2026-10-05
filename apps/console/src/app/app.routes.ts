import { Route } from '@angular/router';
import { projectExists, restoreLastPlace } from './shell.guards';

/**
 * The routing tree (architect note on #23). Order matters: the guarded `p/:slug` must come before
 * the unguarded one that renders "project not found" — `app.spec.ts` asserts it.
 */
export const appRoutes: Route[] = [
  { path: '', pathMatch: 'full', canMatch: [restoreLastPlace], children: [] },
  {
    path: 'p/:slug',
    canMatch: [projectExists],
    loadComponent: () => import('@console/pages/project-space').then((m) => m.ProjectSpacePage),
    loadChildren: () => import('@console/pages/project-space').then((m) => m.projectSpaceChildRoutes),
  },
  {
    // The fallback for the same path: unknown or archived slug, any screen below it, the URL kept as typed.
    path: 'p/:slug',
    data: { reason: 'project' },
    loadComponent: () => import('@console/pages/project-not-found').then((m) => m.ProjectNotFoundPage),
    children: [{ path: '**', children: [] }],
  },
  { path: 'needs-you', loadComponent: () => import('@console/pages/needs-you').then((m) => m.NeedsYouPage) },
  { path: 'overview', loadComponent: () => import('@console/pages/overview').then((m) => m.OverviewPage) },
  { path: 'settings', loadChildren: () => import('@console/pages/settings').then((m) => m.settingsRoutes) },
  {
    path: '**',
    data: { reason: 'route' },
    loadComponent: () => import('@console/pages/project-not-found').then((m) => m.ProjectNotFoundPage),
  },
];
