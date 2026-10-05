import { Route } from '@angular/router';
import { NewProjectPage } from './new-project.page';
import { ProjectSetupPage } from './project-setup.page';
import { SettingsPage } from './settings.page';

/**
 * The Settings area (#24) under `/settings`. `projects` is the UX spec's address of the list, which lives on
 * Settings itself; `projects/new` is declared before `projects/:slug` so "new" never reads as a slug.
 */
export const settingsRoutes: Route[] = [
  { path: '', pathMatch: 'full', component: SettingsPage },
  { path: 'projects', pathMatch: 'full', redirectTo: '' },
  { path: 'projects/new', component: NewProjectPage },
  { path: 'projects/:slug', component: ProjectSetupPage },
];
