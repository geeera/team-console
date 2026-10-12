import { Route } from '@angular/router';
import { ADD_PROJECT_URL } from '@console/entities/project';
import { ProjectSetupPage } from './project-setup.page';
import { SettingsPage } from './settings.page';

/**
 * The Settings area (#24) under `/settings`. Settings holds settings only (owner decision on #194): projects are
 * added on All projects, so the old New project address leads there. `projects/new` is declared before
 * `projects/:slug` so "new" never reads as a slug. The setup page keeps its address until it moves out of Settings.
 */
export const settingsRoutes: Route[] = [
  { path: '', pathMatch: 'full', component: SettingsPage },
  { path: 'projects', pathMatch: 'full', redirectTo: '' },
  { path: 'projects/new', pathMatch: 'full', redirectTo: ADD_PROJECT_URL },
  { path: 'projects/:slug', component: ProjectSetupPage },
];
