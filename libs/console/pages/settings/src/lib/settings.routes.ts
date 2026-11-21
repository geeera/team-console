import { Route } from '@angular/router';
import { environmentCopyReady } from '@console/entities/environment';
import { ADD_PROJECT_URL } from '@console/entities/project';
import { environmentRoutes } from './environment/environment.routes';
import { ProjectSetupPage } from './project-setup.page';
import { SettingsPage } from './settings.page';

/**
 * The Settings area (#24) under `/settings`. Settings holds settings only (owner decision on #194): projects are
 * added on All projects, so the old New project address leads there. `projects/new` is declared before
 * `projects/:slug` so "new" never reads as a slug. The setup page keeps its address until it moves out of Settings.
 */
export const settingsRoutes: Route[] = [
  // The Environment row's copy lives in the environment chunk (#104), so Settings waits for it too.
  { path: '', pathMatch: 'full', component: SettingsPage, canActivate: [environmentCopyReady] },
  { path: 'projects', pathMatch: 'full', redirectTo: '' },
  { path: 'projects/new', pathMatch: 'full', redirectTo: ADD_PROJECT_URL },
  { path: 'projects/:slug', component: ProjectSetupPage },
  // Settings › project › Team (#688): its own chunk, with the editor; unsaved edits ask before leaving.
  {
    path: 'projects/:slug/team',
    loadComponent: () => import('./team/team.page').then((m) => m.TeamPage),
    canDeactivate: [(page: { canLeave(): Promise<boolean> }) => page.canLeave()],
  },
  // Settings › project › GitHub Actions (#759): the customer's own setup, its own chunk.
  {
    path: 'projects/:slug/actions',
    loadComponent: () => import('./actions/project-actions.page').then((m) => m.ProjectActionsPage),
  },
  // Settings › Runners (#464): its own chunk; nothing on the main Settings screen needs it.
  { path: 'runners', loadComponent: () => import('./runners/runners.page').then((m) => m.RunnersPage) },
  ...environmentRoutes,
];
